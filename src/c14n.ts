import{NamespaceStack,type QName}from'./namespaces.js';
import{XMLStreamParser,type Attribute,type ParserEvent}from'./parser.js';

export const XML_NAMESPACE='http://www.w3.org/XML/1998/namespace';

export interface CanonicalSink{write(chunk:string):void}

export class StringSink implements CanonicalSink{
  #chunks:string[]=[];
  write(chunk:string):void{this.#chunks.push(chunk)}
  get text():string{return this.#chunks.join('')}
}

/** Counts the canonical bytes written to it (strings are encoded as UTF-8). */
export class ByteCountSink implements CanonicalSink{
  #bytes=0;
  write(chunk:string):void{this.#bytes+=Buffer.byteLength(chunk,'utf8')}
  get bytes():number{return this.#bytes}
}

/** Fan-out sink: every chunk is forwarded to all delegates. */
export class TeeSink implements CanonicalSink{
  constructor(private readonly sinks:CanonicalSink[]){}
  write(chunk:string):void{for(const s of this.sinks)s.write(chunk)}
}

export interface CanonicalizeOptions{
  /** Element path selector: `/a/b/c` from the root, or `//a/b` anchored anywhere. Steps: `name`, `prefix:name`, `*`. */
  select:string;
  /** Prefix bindings used to resolve prefixed selector steps. */
  namespaces?:Record<string,string>;
  /** Keep comments inside the selected subtrees. Default false. */
  withComments?:boolean;
}

/** Path step identifying one element: its qualified name and 1-based position among same-named siblings. */
export interface PathStep{name:string;position:number}

export interface FragmentMeta{
  /** 0-based ordinal in the order the matched elements start in the document. */
  index:number;
  /** Absolute element path, e.g. `/root[1]/rec[2]/item[1]`. */
  path:string;
  /** One entry per element from the document root to the matched element. */
  steps:readonly PathStep[];
}

export interface FragmentResult<T> extends FragmentMeta{
  /** Length of this fragment's independent canonical form, in UTF-8 bytes. */
  bytes:number;
  /** Value produced by the sink factory (e.g. a StringSink or HashSink handle). */
  sink:T;
}

/**
 * Receives the lifecycle of one matched subtree. `open` is called when the
 * element starts (before any canonical bytes are produced), `close` when it
 * ends; the returned sink receives exactly the bytes of that subtree.
 */
export interface FragmentHandler<T extends CanonicalSink=CanonicalSink>{
  open(meta:FragmentMeta):T;
  close(meta:FragmentMeta,sink:T):void;
}

interface SelectorStep{uri:string|null;local:string|null}
interface BaseFrame{
  name:string;
  qname:QName;
  continuations:number[];
}
interface Frame extends BaseFrame{
  emitting:boolean;
  /** Single shared output for the contiguous selected subtree region. */
  output:C14nOutput|null;
}
interface FragmentFrame<T extends CanonicalSink=CanonicalSink> extends BaseFrame{
  /** Active fragment outputs that contain this element; a matched element adds its own output. */
  outputs:C14nOutput<T>[];
  /** New fragment output created at this element (closed on end), if the element itself matched. */
  own:C14nOutput<T>|null;
  /** Identity of the fragment opened by this element, if it matched. */
  meta:FragmentMeta|null;
}

const escapeText=(s:string):string=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\r/g,'&#xD;');
const escapeAttribute=(s:string):string=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;').replace(/\t/g,'&#x9;').replace(/\n/g,'&#xA;').replace(/\r/g,'&#xD;');
const byCodePoint=(a:string,b:string):number=>a<b?-1:a>b?1:0;

const compileSelector=(select:string,namespaces:Record<string,string>):{steps:SelectorStep[];descendant:boolean}=>{
  const s=select.trim();
  const descendant=s.startsWith('//');
  if(!descendant&&!s.startsWith('/'))throw new Error(`selector must start with "/" or "//": ${select}`);
  const body=s.slice(descendant?2:1);
  if(!body)throw new Error(`selector selects nothing: ${select}`);
  const steps=body.split('/').map((part):SelectorStep=>{
    if(!part)throw new Error(`empty step in selector: ${select}`);
    if(part==='*')return{uri:null,local:null};
    if(part.includes(':')){
      const[prefix,local]=part.split(':',2);
      const uri=namespaces[prefix];
      if(uri===undefined)throw new Error(`unknown prefix "${prefix}" in selector: ${select}`);
      return{uri,local};
    }
    return{uri:null,local:part}; // unprefixed steps match the local name in any namespace
  });
  return{steps,descendant};
};

const stepMatches=(step:SelectorStep,q:QName):boolean=>
  (step.local===null||step.local===q.local)&&(step.uri===null||step.uri===q.uri);

interface VisibleAttribute{qname:QName;name:string;value:string}

/** Collect namespace declarations and validate them; returns the declarations plus the resolved visible attributes. */
const prepareElement=(ns:NamespaceStack,name:string,attributes:Attribute[]):
  {declarations:Record<string,string>;qname:QName;visible:VisibleAttribute[]}=>{
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
  ns.start(declarations);
  const resolve=(n:string,attribute:boolean):QName=>{
    const q=ns.resolve(n,attribute);
    if(q.prefix==='xmlns')throw new Error('the xmlns prefix must not be used by element or attribute names');
    if(q.prefix==='xml')return{...q,uri:XML_NAMESPACE};
    if(q.prefix!==''&&q.uri==='')throw new Error(`unbound prefix "${q.prefix}"`);
    return q;
  };
  const qname=resolve(name,false);
  const visible:VisibleAttribute[]=[];
  const expanded=new Set<string>();
  for(const a of attributes){
    if(a.name==='xmlns'||a.name.startsWith('xmlns:'))continue;
    const aq=resolve(a.name,true);
    const key=`${aq.uri}\t${aq.local}`;
    if(expanded.has(key))throw new Error(`duplicate attribute "${a.name}"`);
    expanded.add(key);
    visible.push({qname:aq,name:a.name,value:a.value});
  }
  return{declarations,qname,visible};
};

/**
 * One independent exclusive-c14n output. Holds its own rendered-namespace
 * context stack so that a nested match can be emitted as a standalone subtree
 * (re-rendering bindings inherited from ancestors) without affecting, or
 * borrowing state from, the outer subtree it is also part of.
 */
class C14nOutput<T extends CanonicalSink=CanonicalSink>{
  #outputContext:Record<string,string>[]=[];
  constructor(readonly sink:T){}

  startElement(name:string,qname:QName,visible:VisibleAttribute[]):void{
    // exclusive c14n: render only bindings visibly utilized here that differ from the parent output context
    const parentContext=this.#outputContext.at(-1)??{};
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
    const sorted=[...visible].sort((a,b)=>byCodePoint(a.qname.uri,b.qname.uri)||byCodePoint(a.qname.local,b.qname.local));
    for(const a of sorted)out+=` ${a.name}="${escapeAttribute(a.value)}"`;
    this.sink.write(out+'>');
    this.#outputContext.push({...parentContext,...rendered});
  }

  endElement(name:string):void{
    this.sink.write(`</${name}>`);
    this.#outputContext.pop();
  }

  text(data:string):void{this.sink.write(escapeText(data))}
  comment(data:string):void{this.sink.write(`<!--${data}-->`)}
  pi(target:string,data:string):void{this.sink.write(data?`<?${target} ${data}?>`:`<?${target}?>`)}
}

/**
 * Streaming exclusive canonicalization of the subtrees matched by a simple path selector.
 * Only namespace bindings that are visibly utilized and differ from the parent canonical
 * context are emitted; attributes are sorted by (namespace URI, local name).
 *
 * All matched subtrees are concatenated into one sink. When the same element
 * (or an ancestor) is already being emitted, a nested match is rendered once
 * as part of that output and does not start a second one. Use
 * {@link FragmentCanonicalizer} to get an independent result per match.
 */
export class Canonicalizer{
  #ns=new NamespaceStack();
  #frames:Frame[]=[];
  #emitDepth=0;
  #steps:SelectorStep[];
  #descendant:boolean;
  #withComments:boolean;
  #sink:CanonicalSink;

  constructor(options:CanonicalizeOptions,sink:CanonicalSink){
    const{steps,descendant}=compileSelector(options.select,options.namespaces??{});
    this.#steps=steps;this.#descendant=descendant;
    this.#withComments=options.withComments??false;
    this.#sink=sink;
  }

  handle(event:ParserEvent):void{
    switch(event.type){
      case'start':this.#startElement(event.name,event.attributes);break;
      case'end':this.#endElement(event.name);break;
      case'text':if(this.#emitDepth>0)this.#sink.write(escapeText(event.data));break;
      case'comment':if(this.#emitDepth>0&&this.#withComments)this.#sink.write(`<!--${event.data}-->`);break;
      case'pi':if(this.#emitDepth>0)this.#sink.write(event.data?`<?${event.target} ${event.data}?>`:`<?${event.target}?>`);break;
    }
  }

  #startElement(name:string,attributes:Attribute[]):void{
    const{qname,visible}=prepareElement(this.#ns,name,attributes);
    const parent=this.#frames.at(-1);
    let emitting=this.#emitDepth>0;
    const continuations:number[]=[];
    if(!emitting){
      const candidates=[...new Set([...parent?.continuations??[],...(this.#descendant||!parent?[0]:[])])];
      for(const i of candidates){
        const step=this.#steps[i];
        if(stepMatches(step,qname)){
          if(i===this.#steps.length-1)emitting=true;
          else continuations.push(i+1);
        }
      }
    }
    // One output spans the whole contiguous emitting region so its rendered
    // namespace context carries from the apex down to every descendant.
    const output=emitting?(parent?.output??new C14nOutput(this.#sink)):null;
    this.#frames.push({name,qname,emitting,continuations,output});
    if(!emitting)return;
    output!.startElement(name,qname,visible);
    this.#emitDepth++;
  }

  #endElement(name:string):void{
    const frame=this.#frames.pop();
    if(!frame||frame.name!==name)throw new Error(`unexpected end element </${name}>`);
    this.#ns.end();
    if(!frame.emitting)return;
    frame.output!.endElement(name);
    this.#emitDepth--;
  }
}

/**
 * Per-fragment streaming canonicalization. Every subtree matched by the
 * selector gets its own {@link C14nOutput} and therefore its own namespace
 * context and sink; a nested match is both rendered inside its ancestor's
 * output and produced as a standalone result. Results are announced in the
 * order the matched elements start in the document.
 *
 * Drive it exactly like {@link Canonicalizer}: feed a {@link XMLStreamParser}
 * and call `end()`; a malformed document or invalid namespace throws, and no
 * partial fragment list is returned by the higher-level helpers.
 */
export class FragmentCanonicalizer<T extends CanonicalSink=CanonicalSink>{
  #ns=new NamespaceStack();
  #frames:FragmentFrame<T>[]=[];
  #steps:SelectorStep[];
  #descendant:boolean;
  #withComments:boolean;
  #handler:FragmentHandler<T>;
  /** Same-name sibling counters per parent frame: map of qualified name -> running count. */
  #siblings:Map<string,number>[]=[];
  /** Current element path (one entry per open element). */
  #path:PathStep[]=[];
  #ordinal=0;

  constructor(options:CanonicalizeOptions,handler:FragmentHandler<T>){
    const{steps,descendant}=compileSelector(options.select,options.namespaces??{});
    this.#steps=steps;this.#descendant=descendant;
    this.#withComments=options.withComments??false;
    this.#handler=handler;
  }

  handle(event:ParserEvent):void{
    switch(event.type){
      case'start':this.#startElement(event.name,event.attributes);break;
      case'end':this.#endElement(event.name);break;
      case'text':for(const o of this.#frames.at(-1)?.outputs??[])o.text(event.data);break;
      case'comment':if(this.#withComments)for(const o of this.#frames.at(-1)?.outputs??[])o.comment(event.data);break;
      case'pi':for(const o of this.#frames.at(-1)?.outputs??[])o.pi(event.target,event.data);break;
    }
  }

  #startElement(name:string,attributes:Attribute[]):void{
    const{qname,visible}=prepareElement(this.#ns,name,attributes);

    // 1-based position among same-named siblings
    const counters=this.#siblings.at(-1);
    const position=(counters?.get(name)??0)+1;
    counters?.set(name,position);
    this.#path.push({name,position});

    // Selector matching runs at every depth (unlike the concatenating Canonicalizer),
    // so an element nested inside an already-open match can match on its own.
    const parent=this.#frames.at(-1);
    const continuations:number[]=[];
    let matched=false;
    const candidates=[...new Set([...parent?.continuations??[],...(this.#descendant||!parent?[0]:[])])];
    for(const i of candidates){
      const step=this.#steps[i];
      if(stepMatches(step,qname)){
        if(i===this.#steps.length-1)matched=true;
        else continuations.push(i+1);
      }
    }

    const inheritedOutputs=parent?.outputs??[];
    let own:C14nOutput<T>|null=null;
    let meta:FragmentMeta|null=null;
    if(matched){
      const steps=this.#path.map(s=>({...s}));
      meta={
        index:this.#ordinal++,
        steps,
        path:'/'+steps.map(s=>`${s.name}[${s.position}]`).join('/'),
      };
      const sink=this.#handler.open(meta);
      own=new C14nOutput<T>(sink);
    }
    const outputs=[...inheritedOutputs];
    if(own)outputs.push(own);
    this.#frames.push({name,qname,continuations,outputs,own,meta});
    this.#siblings.push(new Map());
    for(const o of outputs)o.startElement(name,qname,visible);
  }

  #endElement(name:string):void{
    const frame=this.#frames.pop();
    if(!frame||frame.name!==name)throw new Error(`unexpected end element </${name}>`);
    for(const o of frame.outputs)o.endElement(name);
    this.#siblings.pop();
    this.#path.pop();
    this.#ns.end();
    if(frame.own&&frame.meta)this.#handler.close(frame.meta,frame.own.sink);
  }
}

export const canonicalize=(input:string|Iterable<string|Uint8Array>,options:CanonicalizeOptions,sink:CanonicalSink):void=>{
  const canonicalizer=new Canonicalizer(options,sink);
  const parser=new XMLStreamParser(e=>canonicalizer.handle(e));
  if(typeof input==='string')parser.feed(input);
  else for(const chunk of input)parser.feed(chunk);
  parser.end();
};

export const canonicalForm=(input:string|Iterable<string|Uint8Array>,options:CanonicalizeOptions):string=>{
  const sink=new StringSink();
  canonicalize(input,options,sink);
  return sink.text;
};

/**
 * Convenience wrapper around {@link FragmentCanonicalizer}: canonicalize every
 * matched subtree independently in one pass and return one result per match,
 * in document start order. Each result carries the standalone canonical text.
 */
export const canonicalFragments=(input:string|Iterable<string|Uint8Array>,options:CanonicalizeOptions):FragmentResult<StringSink>[]=>{
  const results:FragmentResult<StringSink>[]=[];
  const canonicalizer=new FragmentCanonicalizer<StringSink>(options,{
    open:()=>new StringSink(),
    close:(meta,sink)=>results.push({...meta,bytes:Buffer.byteLength(sink.text,'utf8'),sink}),
  });
  const parser=new XMLStreamParser(e=>canonicalizer.handle(e));
  if(typeof input==='string')parser.feed(input);
  else for(const chunk of input)parser.feed(chunk);
  parser.end();
  // Nested matches close before their ancestors; report in document start order.
  return results.sort((a,b)=>a.index-b.index);
};
