import{NamespaceStack,type QName}from'./namespaces.js';
import{XMLStreamParser,type Attribute,type ParserEvent}from'./parser.js';

export const XML_NAMESPACE='http://www.w3.org/XML/1998/namespace';

export interface CanonicalSink{write(chunk:string):void}

export class StringSink implements CanonicalSink{
  #chunks:string[]=[];
  write(chunk:string):void{this.#chunks.push(chunk)}
  get text():string{return this.#chunks.join('')}
}

export interface CanonicalizeOptions{
  /** Element path selector: `/a/b/c` from the root, or `//a/b` anchored anywhere. Steps: `name`, `prefix:name`, `*`. */
  select:string;
  /** Prefix bindings used to resolve prefixed selector steps. */
  namespaces?:Record<string,string>;
  /** Keep comments inside the selected subtrees. Default false. */
  withComments?:boolean;
}

interface SelectorStep{uri:string|null;local:string|null}
interface Frame{name:string;qname:QName;emitting:boolean;continuations:number[]}

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

/**
 * Streaming exclusive canonicalization of the subtrees matched by a simple path selector.
 * Only namespace bindings that are visibly utilized and differ from the parent canonical
 * context are emitted; attributes are sorted by (namespace URI, local name).
 */
export class Canonicalizer{
  #ns=new NamespaceStack();
  #frames:Frame[]=[];
  #outputContext:Record<string,string>[]=[];
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
    const visible:{qname:QName;name:string;value:string}[]=[];
    const expanded=new Set<string>();
    for(const a of attributes){
      if(a.name==='xmlns'||a.name.startsWith('xmlns:'))continue;
      const aq=this.#resolve(a.name,true);
      const key=`${aq.uri}\t${aq.local}`;
      if(expanded.has(key))throw new Error(`duplicate attribute "${a.name}"`);
      expanded.add(key);
      visible.push({qname:aq,name:a.name,value:a.value});
    }
    const parent=this.#frames.at(-1);
    let emitting=this.#emitDepth>0;
    const continuations:number[]=[];
    if(!emitting){
      const candidates=[...parent?.continuations??[]];
      if(this.#descendant||!parent)candidates.push(0);
      for(const i of candidates){
        const step=this.#steps[i];
        if((step.local===null||step.local===qname.local)&&(step.uri===null||step.uri===qname.uri)){
          if(i===this.#steps.length-1)emitting=true;
          else continuations.push(i+1);
        }
      }
    }
    this.#frames.push({name,qname,emitting,continuations});
    if(!emitting)return;
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
    visible.sort((a,b)=>byCodePoint(a.qname.uri,b.qname.uri)||byCodePoint(a.qname.local,b.qname.local));
    for(const a of visible)out+=` ${a.name}="${escapeAttribute(a.value)}"`;
    this.#sink.write(out+'>');
    this.#outputContext.push({...parentContext,...rendered});
    this.#emitDepth++;
  }

  #endElement(name:string):void{
    const frame=this.#frames.pop();
    if(!frame||frame.name!==name)throw new Error(`unexpected end element </${name}>`);
    this.#ns.end();
    if(!frame.emitting)return;
    this.#sink.write(`</${name}>`);
    this.#outputContext.pop();
    this.#emitDepth--;
  }

  #resolve(name:string,attribute:boolean):QName{
    const q=this.#ns.resolve(name,attribute);
    if(q.prefix==='xmlns')throw new Error('the xmlns prefix must not be used by element or attribute names');
    if(q.prefix==='xml')return{...q,uri:XML_NAMESPACE};
    if(q.prefix!==''&&q.uri==='')throw new Error(`unbound prefix "${q.prefix}"`);
    return q;
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
