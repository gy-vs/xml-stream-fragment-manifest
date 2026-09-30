export type Attribute={name:string;value:string};
export type ParserEvent=
  |{type:'start';name:string;attributes:Attribute[];selfClosing:boolean}
  |{type:'end';name:string}
  |{type:'text';data:string}
  |{type:'comment';data:string}
  |{type:'pi';target:string;data:string};

const NAME_START=/^[A-Za-z_\u0080-\u{10FFFF}]$/u;
const NAME_CHAR=/^[A-Za-z0-9._\-\u0080-\u{10FFFF}]$/u;
const normalizeNewlines=(s:string):string=>s.includes('\r')?s.replace(/\r\n/g,'\n').replace(/\r/g,'\n'):s;

/** Incremental, namespace-agnostic XML tokenizer. Feed string or UTF-8 byte chunks, then call end(). */
export class XMLStreamParser{
  #buf='';
  #decoder=new TextDecoder('utf-8',{fatal:true});
  #stack:string[]=[];
  #atStart=true;
  #seenRoot=false;
  constructor(private readonly emit:(event:ParserEvent)=>void){}

  feed(chunk:string|Uint8Array):void{
    this.#buf+=typeof chunk==='string'?chunk:this.#decoder.decode(chunk,{stream:true});
    this.#drain(false);
  }
  end():void{
    this.#buf+=this.#decoder.decode();
    this.#drain(true);
    if(this.#stack.length)throw new Error(`unclosed element <${this.#stack.at(-1)}>`);
    if(!this.#seenRoot)throw new Error('document has no root element');
  }

  #drain(final:boolean):void{
    for(;;){
      const b=this.#buf;
      if(!b)return;
      if(b[0]==='<'){
        if(b.length<2){if(final)throw new Error('truncated markup');return}
        const c=b[1];
        if(c==='?'){if(!this.#pi(final))return}
        else if(c==='/'){if(!this.#endTag(final))return}
        else if(c==='!'){
          if(b.startsWith('<!--')){if(!this.#comment(final))return}
          else if(b.startsWith('<![CDATA[')){if(!this.#cdata(final))return}
          else if(b.startsWith('<!DOCTYPE')){if(!this.#doctype(final))return}
          else if('<!--'.startsWith(b)||'<![CDATA['.startsWith(b)||'<!DOCTYPE'.startsWith(b)){if(final)throw new Error('truncated markup');return}
          else throw new Error(`unsupported markup: ${b.slice(0,12)}`);
        }
        else if(!this.#startTag(final))return;
      }else if(!this.#text(final))return;
    }
  }

  /** Returns false when the token is incomplete and more input is needed. */
  #text(final:boolean):boolean{
    const lt=this.#buf.indexOf('<');
    let raw:string;
    if(lt>=0){raw=this.#buf.slice(0,lt);this.#buf=this.#buf.slice(lt)}
    else if(final){raw=this.#buf;this.#buf=''}
    else{
      // hold back a trailing CR (may be half of a CRLF) and a trailing incomplete entity
      let safe=this.#buf.length;
      const amp=this.#buf.lastIndexOf('&');
      if(amp>this.#buf.lastIndexOf(';'))safe=amp;
      if(safe>0&&this.#buf[safe-1]==='\r')safe--;
      if(safe===0)return false;
      raw=this.#buf.slice(0,safe);this.#buf=this.#buf.slice(safe);
    }
    if(raw.includes(']]>'))throw new Error('"]>" is not allowed in character data');
    const data=this.#expand(normalizeNewlines(raw));
    this.#atStart=false;
    if(this.#stack.length===0){
      if(data.trim())throw new Error('character data outside the root element');
      return true; // prolog/epilog whitespace is not reported
    }
    if(data)this.emit({type:'text',data});
    return true;
  }

  #comment(final:boolean):boolean{
    const end=this.#buf.indexOf('-->',4);
    if(end<0){if(final)throw new Error('truncated comment');return false}
    const data=this.#buf.slice(4,end);
    if(data.includes('--')||data.endsWith('-'))throw new Error('comment must not contain "--"');
    this.#buf=this.#buf.slice(end+3);
    this.#atStart=false;
    this.emit({type:'comment',data:normalizeNewlines(data)});
    return true;
  }

  #cdata(final:boolean):boolean{
    const end=this.#buf.indexOf(']]>',9);
    if(end<0){if(final)throw new Error('truncated CDATA section');return false}
    const data=this.#buf.slice(9,end);
    this.#buf=this.#buf.slice(end+3);
    if(this.#stack.length===0)throw new Error('CDATA section outside the root element');
    this.#atStart=false;
    if(data)this.emit({type:'text',data:normalizeNewlines(data)});
    return true;
  }

  #doctype(final:boolean):boolean{
    if(this.#seenRoot)throw new Error('DOCTYPE must precede the root element');
    for(let i=9;i<this.#buf.length;i++){
      const c=this.#buf[i];
      if(c==='[')throw new Error('DOCTYPE internal subset is not supported');
      if(c==='>'){this.#buf=this.#buf.slice(i+1);this.#atStart=false;return true}
    }
    if(final)throw new Error('truncated DOCTYPE');
    return false;
  }

  #pi(final:boolean):boolean{
    const end=this.#buf.indexOf('?>');
    if(end<0){if(final)throw new Error('truncated processing instruction');return false}
    const inner=this.#buf.slice(2,end);
    this.#buf=this.#buf.slice(end+2);
    const m=/^(\S+)(?:\s+([\s\S]*))?$/.exec(inner);
    if(!m)throw new Error(`malformed processing instruction: ${inner.slice(0,20)}`);
    const target=m[1],data=m[2]??'';
    this.#checkName(target);
    if(target==='xml'){
      if(!this.#atStart)throw new Error('xml declaration must be the very first thing in the document');
      const enc=/\bencoding\s*=\s*["']([^"']+)["']/.exec(data);
      if(enc&&!/^utf-?8$/i.test(enc[1]))throw new Error(`unsupported encoding "${enc[1]}"`);
      this.#atStart=false;
      return true; // the declaration is not reported
    }
    if(target.toLowerCase()==='xml')throw new Error(`invalid PI target "${target}"`);
    this.#atStart=false;
    this.emit({type:'pi',target,data:normalizeNewlines(data)});
    return true;
  }

  #endTag(final:boolean):boolean{
    const end=this.#buf.indexOf('>');
    if(end<0){if(final)throw new Error('truncated end tag');return false}
    const name=this.#buf.slice(2,end).trim();
    this.#checkName(name);
    this.#buf=this.#buf.slice(end+1);
    const open=this.#stack.pop();
    if(open===undefined)throw new Error(`unexpected end tag </${name}>`);
    if(open!==name)throw new Error(`mismatched end tag </${name}>, expected </${open}>`);
    this.#atStart=false;
    this.emit({type:'end',name});
    return true;
  }

  #startTag(final:boolean):boolean{
    const end=this.#tagEnd();
    if(end<0){if(final)throw new Error('truncated start tag');return false}
    let inner=this.#buf.slice(1,end);
    this.#buf=this.#buf.slice(end+1);
    let selfClosing=false;
    if(inner.endsWith('/')){selfClosing=true;inner=inner.slice(0,-1)}
    let i=0;
    const ws=()=>{while(i<inner.length&&/\s/.test(inner[i]))i++};
    const readName=():string=>{
      const m=/^[^\s=/>"'<&]+/.exec(inner.slice(i));
      if(!m)throw new Error(`malformed start tag <${inner.slice(0,20)}>`);
      i+=m[0].length;return m[0];
    };
    ws();
    const name=readName();
    this.#checkName(name);
    const attributes:Attribute[]=[];
    const seen=new Set<string>();
    for(;;){
      ws();
      if(i>=inner.length)break;
      const an=readName();
      this.#checkName(an);
      if(seen.has(an))throw new Error(`duplicate attribute "${an}"`);
      seen.add(an);
      ws();
      if(inner[i]!=='=')throw new Error(`expected "=" after attribute "${an}"`);
      i++;ws();
      const q=inner[i];
      if(q!=='"'&&q!=="'")throw new Error(`attribute "${an}" must be quoted`);
      const close=inner.indexOf(q,i+1);
      let value=inner.slice(i+1,close);
      i=close+1;
      if(value.includes('<'))throw new Error(`"<" is not allowed in attribute "${an}"`);
      value=this.#expand(normalizeNewlines(value).replace(/[\t\n]/g,' '));
      attributes.push({name:an,value});
    }
    if(this.#stack.length===0){
      if(this.#seenRoot)throw new Error('multiple root elements');
      this.#seenRoot=true;
    }
    this.#stack.push(name);
    this.#atStart=false;
    this.emit({type:'start',name,attributes,selfClosing});
    if(selfClosing){this.#stack.pop();this.emit({type:'end',name})}
    return true;
  }

  #tagEnd():number{
    let quote='';
    for(let i=1;i<this.#buf.length;i++){
      const c=this.#buf[i];
      if(quote){if(c===quote)quote=''}
      else if(c==='"'||c==="'")quote=c;
      else if(c==='>')return i;
    }
    return -1;
  }

  #checkName(n:string):void{
    const parts=n.split(':');
    if(parts.length>2)throw new Error(`invalid qualified name "${n}"`);
    for(const p of parts){
      const chars=[...p];
      if(!chars.length||!NAME_START.test(chars[0])||!chars.slice(1).every(c=>NAME_CHAR.test(c)))
        throw new Error(`invalid name "${n}"`);
    }
  }

  #expand(s:string):string{
    if(!s.includes('&'))return s;
    let out='',i=0;
    for(;;){
      const amp=s.indexOf('&',i);
      if(amp<0)return out+s.slice(i);
      out+=s.slice(i,amp);
      const semi=s.indexOf(';',amp+1);
      if(semi<0)throw new Error('unterminated entity reference');
      out+=this.#entity(s.slice(amp+1,semi));
      i=semi+1;
    }
  }

  #entity(body:string):string{
    switch(body){
      case'lt':return'<';case'gt':return'>';case'amp':return'&';case'apos':return"'";case'quot':return'"';
    }
    const m=/^#(?:x([0-9A-Fa-f]+)|(\d+))$/.exec(body);
    if(!m)throw new Error(`undefined entity "&${body};"`);
    const cp=parseInt(m[1]??m[2],m[1]?16:10);
    if(cp===0||cp>0x10FFFF||(cp>=0xD800&&cp<=0xDFFF)||(cp<0x20&&cp!==0x9&&cp!==0xA&&cp!==0xD))
      throw new Error(`invalid character reference "&#${body.slice(1)};"`);
    return String.fromCodePoint(cp);
  }
}
