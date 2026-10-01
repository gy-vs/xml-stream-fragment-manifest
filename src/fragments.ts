import{createHash}from'node:crypto';
import{NamespaceStack,type QName}from'./namespaces.js';
import{
  XML_NAMESPACE,
  compileSelector,
  escapeAttribute,
  escapeText,
  type CanonicalizeOptions,
  type SelectorStep,
}from'./c14n.js';
import{XMLStreamParser,type Attribute,type ParserEvent}from'./parser.js';

/** One step of a fragment's element path, using the lexical QName as written in the source. */
export interface FragmentPathStep{
  /** Qualified name as written in the source, e.g. `item` or `p:leaf`. */
  name:string;
  /** Namespace URI the name resolved to in the source (`''` when none). */
  uri:string;
  /** Local name without the prefix. */
  local:string;
  /** 1-based position among same-expanded-name (same URI and local name) siblings. */
  position:number;
}

/** Identity of a matched subtree, known as soon as its start tag has been parsed. */
export interface FragmentHeader{
  /** 0-based ordinal in document start (opening-tag) order. */
  index:number;
  /** Steps from the document root to this element. */
  path:FragmentPathStep[];
  /** `/root/sec/item[2]`, with a `[n]` predicate only after the first same-name sibling. */
  pathString:string;
}

/** A completed fragment: identity plus the independently produced canonical output stats. */
export interface FragmentResult extends FragmentHeader{
  /** Length of this fragment's canonical form in UTF-8 bytes. */
  bytes:number;
  /** Digest of this fragment's canonical bytes; nested matches never share digest state. */
  digest:string;
}

/** The independent canonical byte stream of one matched subtree. */
export interface FragmentStream{
  /** Receives one chunk of this fragment's canonical bytes; never another fragment's. */
  write(chunk:string):void;
  /** Called once at the fragment's end tag; the digest can now be finalized. */
  close(header:FragmentHeader):void;
}

/**
 * Factory for per-fragment streams. A new stream is created at every matched
 * element's start tag, so multiple overlapping (nested) matches never borrow
 * each other's mutable state.
 */
export interface FragmentHandler{
  open(header:FragmentHeader):FragmentStream;
}

/** Format a structured path as `/a/b[2]/c`. */
export const formatPath=(path:FragmentPathStep[]):string=>
  '/'+path.map(s=>s.position>1?`${s.name}[${s.position}]`:s.name).join('/');

/** UTF-8 byte length of a string, counted incrementally per write (no buffering). */
export const utf8ByteLength=(s:string):number=>{
  let n=0;
  for(const ch of s){
    const cp=ch.codePointAt(0)!;
    n+=cp<0x80?1:cp<0x800?2:cp<0x10000?3:4;
  }
  return n;
};

interface VisibleAttr{qname:QName;name:string;value:string}
interface Emission{
  header:FragmentHeader;
  stream:FragmentStream;
  /** Exclusive-c14n output contexts along this emission's own rendered depth. */
  context:Record<string,string>[];
}
interface FragmentFrame{
  name:string;
  step:FragmentPathStep;
  /** Emissions whose apex is an ancestor: this element is their content. */
  covering:Emission[];
  /** Emission whose apex is this element itself, if the selector matched here. */
  own:Emission|null;
  /** Selector step indices that can still match along this structural branch. */
  continuations:number[];
  /** Same-name sibling counters keyed by `uri\tlocal` on this frame's children. */
  childCounts:Map<string,number>;
}

const byCodePoint=(a:string,b:string):number=>a<b?-1:a>b?1:0;

/**
 * Streaming canonicalizer that produces one independent output per matched
 * subtree instead of concatenating every match into one stream.
 *
 * The selector is evaluated structurally at every element, independently of
 * any enclosing match: a descendant selector (`//a`) therefore matches an
 * inner `a` even while it is simultaneously rendered as content of an outer
 * `a`'s stream. Every matched apex starts with an empty exclusive-c14n
 * namespace context, so an inner fragment serializes exactly as it would when
 * canonicalized on its own, including namespace bindings inherited from
 * ancestors. Retained state is bounded by the open-element depth, never by the
 * document size.
 */
export class FragmentCanonicalizer{
  #ns=new NamespaceStack();
  #frames:FragmentFrame[]=[];
  #steps:SelectorStep[];
  #descendant:boolean;
  #withComments:boolean;
  #handler:FragmentHandler;
  #count=0;

  constructor(options:CanonicalizeOptions,handler:FragmentHandler){
    const{steps,descendant}=compileSelector(options.select,options.namespaces??{});
    this.#steps=steps;this.#descendant=descendant;
    this.#withComments=options.withComments??false;
    this.#handler=handler;
  }

  handle(event:ParserEvent):void{
    switch(event.type){
      case'start':this.#startElement(event.name,event.attributes);break;
      case'end':this.#endElement(event.name);break;
      case'text':{
        const out=escapeText(event.data);
        for(const e of this.#active())e.stream.write(out);
        break;
      }
      case'comment':{
        if(!this.#withComments)break;
        const out=`<!--${event.data}-->`;
        for(const e of this.#active())e.stream.write(out);
        break;
      }
      case'pi':{
        const out=event.data?`<?${event.target} ${event.data}?>`:`<?${event.target}?>`;
        for(const e of this.#active())e.stream.write(out);
        break;
      }
    }
  }

  #active():Emission[]{
    const f=this.#frames.at(-1);
    return f?[...f.covering,...(f.own?[f.own]:[])]:[];
  }

  #startElement(name:string,attributes:Attribute[]):void{
    const declarations:Record<string,string>={};
    for(const a of attributes){
      if(a.name==='xmlns')declarations['']=a.value;
      else if(a.name.startsWith('xmlns:'))declarations[a.name.slice(6)]=a.value;
    }
    for(const[prefix,uri]of Object.entries(declarations)){
      if(prefix==='xmlns')throw new Error('the xmlns prefix must not be declared');
      if(prefix==='xml'&&uri!==XML_NAMESPACE)throw new Error(`the xml prefix must be bound to ${XML_NAMESPACE}`);
      if(prefix!==''&&uri==='')throw new Error(`cannot undeclare the prefix "${prefix}"`);
    }
    this.#ns.start(declarations);
    const qname=this.#resolve(name,false);
    const visible:VisibleAttr[]=[];
    const expanded=new Set<string>();
    for(const a of attributes){
      if(a.name==='xmlns'||a.name.startsWith('xmlns:'))continue;
      const aq=this.#resolve(a.name,true);
      const key=`${aq.uri}\t${aq.local}`;
      if(expanded.has(key))throw new Error(`duplicate attribute "${a.name}"`);
      expanded.add(key);
      visible.push({qname:aq,name:a.name,value:a.value});
    }
    visible.sort((a,b)=>byCodePoint(a.qname.uri,b.qname.uri)||byCodePoint(a.qname.local,b.qname.local));

    const parent=this.#frames.at(-1);
    const countKey=`${qname.uri}\t${qname.local}`;
    const position=(parent?.childCounts.get(countKey)??0)+1;
    parent?.childCounts.set(countKey,position);
    const step:FragmentPathStep={name,uri:qname.uri,local:qname.local,position};

    // Structural selector state is maintained on every branch, independent of
    // emissions already open: an inner node can match on its own while being
    // rendered as content of an outer match.
    const candidates=[...parent?.continuations??[]];
    if(this.#descendant||!parent)candidates.push(0);
    const continuations:number[]=[];
    let apex=false;
    for(const i of candidates){
      const s=this.#steps[i]!;
      if((s.local===null||s.local===qname.local)&&(s.uri===null||s.uri===qname.uri)){
        if(i===this.#steps.length-1)apex=true;
        else continuations.push(i+1);
      }
    }

    const covering=parent?[...parent.covering,...(parent.own?[parent.own]:[])]:[];
    const frame:FragmentFrame={name,step,covering,own:null,continuations,childCounts:new Map()};
    this.#frames.push(frame);

    if(apex){
      const path=this.#frames.map(f=>f.step);
      const header:FragmentHeader={index:this.#count++,path,pathString:formatPath(path)};
      const emission:Emission={header,stream:this.#handler.open(header),context:[]};
      frame.own=emission;
      this.#renderStart(emission,name,qname,visible);
    }
    // The same element is ordinary content of every enclosing matched subtree.
    for(const e of covering)this.#renderStart(e,name,qname,visible);
  }

  #renderStart(e:Emission,name:string,qname:QName,visible:VisibleAttr[]):void{
    // Exclusive c14n against this emission's own context: inherited bindings
    // are redeclared here exactly as for a standalone subtree target.
    const parentContext=e.context.at(-1)??{};
    const utilized=new Map<string,string>([[qname.prefix,qname.uri]]);
    for(const a of visible)if(a.qname.prefix)utilized.set(a.qname.prefix,a.qname.uri);
    const rendered:Record<string,string>={};
    for(const[prefix,uri]of utilized){
      if(prefix==='xml')continue; // implicitly bound, never declared
      if((parentContext[prefix]??'')!==uri)rendered[prefix]=uri;
    }
    let out=`<${name}`;
    for(const prefix of Object.keys(rendered).sort((a,b)=>a===''?-1:b===''?1:byCodePoint(a,b)))
      out+=prefix===''?` xmlns="${escapeAttribute(rendered[prefix])}"`:` xmlns:${prefix}="${escapeAttribute(rendered[prefix])}"`;
    for(const a of visible)out+=` ${a.name}="${escapeAttribute(a.value)}"`;
    e.stream.write(out+'>');
    e.context.push({...parentContext,...rendered});
  }

  #endElement(name:string):void{
    const frame=this.#frames.pop();
    if(!frame||frame.name!==name)throw new Error(`unexpected end element </${name}>`);
    this.#ns.end();
    const closeTag=`</${name}>`;
    for(const e of frame.covering)e.stream.write(closeTag),e.context.pop();
    if(frame.own){
      const e=frame.own;
      e.stream.write(closeTag);
      e.context.pop();
      e.stream.close(e.header); // nested matches close before their ancestors; index keeps start order
    }
  }

  #resolve(name:string,attribute:boolean):QName{
    const q=this.#ns.resolve(name,attribute);
    if(q.prefix==='xmlns')throw new Error('the xmlns prefix must not be used by element or attribute names');
    if(q.prefix==='xml')return{...q,uri:XML_NAMESPACE};
    if(q.prefix!==''&&q.uri==='')throw new Error(`unbound prefix "${q.prefix}"`);
    return q;
  }
}

/**
 * Feed an input once and route each independently canonicalized matched
 * subtree to its own stream from `handler`. Strings or arbitrary iterables of
 * string/UTF-8 chunks are accepted, so single-use sources are consumed in one
 * pass. Throws on malformed XML or invalid namespaces; a throw means no
 * fragment list is produced.
 */
export const canonicalizeFragments=(
  input:string|Iterable<string|Uint8Array>,
  options:CanonicalizeOptions,
  handler:FragmentHandler,
):void=>{
  const canonicalizer=new FragmentCanonicalizer(options,handler);
  const parser=new XMLStreamParser(e=>canonicalizer.handle(e));
  if(typeof input==='string')parser.feed(input);
  else for(const chunk of input)parser.feed(chunk);
  parser.end();
};

/**
 * Streaming handler that finalizes a digest per fragment. Results are exposed
 * after the stream ends, ordered by each element's start-tag position. Memory
 * is bounded by the number of matched fragments (digest state only), not by
 * their byte size.
 */
export class FragmentDigestHandler implements FragmentHandler{
  #results:(FragmentResult|undefined)[]=[];
  constructor(readonly algorithm='sha256',readonly encoding:'hex'|'base64'='hex'){}
  open(header:FragmentHeader):FragmentStream{
    const hash=createHash(this.algorithm);
    let bytes=0;
    return{
      write:chunk=>{hash.update(chunk,'utf8');bytes+=utf8ByteLength(chunk)},
      close:h=>{this.#results[h.index]={...h,bytes,digest:hash.digest(this.encoding)}},
    };
  }
  /** Completed fragments in document start order. */
  get results():FragmentResult[]{
    return this.#results.every(r=>r!==undefined)?(this.#results as FragmentResult[]):[];
  }
}

/** One fragment's independently captured canonical text. */
export interface FragmentText{header:FragmentHeader;text:string}

/**
 * Streaming handler that captures each fragment's canonical text separately.
 * Prefer {@link FragmentDigestHandler} for large inputs: retaining text grows
 * with the total canonical output size.
 */
export class FragmentTextHandler implements FragmentHandler{
  #fragments:(FragmentText|undefined)[]=[];
  open(header:FragmentHeader):FragmentStream{
    const chunks:string[]=[];
    return{
      write:chunk=>{chunks.push(chunk)},
      close:h=>{this.#fragments[h.index]={header:h,text:chunks.join('')}},
    };
  }
  get fragments():FragmentText[]{
    return this.#fragments.every(f=>f!==undefined)?(this.#fragments as FragmentText[]):[];
  }
}

/**
 * One-pass per-fragment digests. Returns an empty array when the selector
 * matches nothing; throws (without returning a partial list) on malformed XML
 * or invalid namespaces.
 */
export const digestFragments=(
  input:string|Iterable<string|Uint8Array>,
  options:CanonicalizeOptions,
  algorithm='sha256',
  encoding:'hex'|'base64'='hex',
):FragmentResult[]=>{
  const handler=new FragmentDigestHandler(algorithm,encoding);
  canonicalizeFragments(input,options,handler);
  return handler.results;
};
