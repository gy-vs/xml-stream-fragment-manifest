import{describe,expect,it}from'vitest';
import{XMLStreamParser,type ParserEvent}from'../src/index.js';

const collect=(chunks:(string|Uint8Array)[]):ParserEvent[]=>{
  const events:ParserEvent[]=[];
  const p=new XMLStreamParser(e=>events.push(e));
  for(const c of chunks)p.feed(c);
  p.end();
  return events;
};
// adjacent text events are a chunking artifact; merge them before comparing
const merged=(events:ParserEvent[]):ParserEvent[]=>events.reduce<ParserEvent[]>((acc,e)=>{
  const last=acc.at(-1);
  if(e.type==='text'&&last?.type==='text')last.data+=e.data;
  else acc.push(e.type==='text'?{...e}:e);
  return acc;
},[]);
const fail=(chunks:(string|Uint8Array)[]):Error=>{
  const p=new XMLStreamParser(()=>{});
  try{for(const c of chunks)p.feed(c);p.end()}catch(e){return e as Error}
  throw new Error('expected the parser to throw');
};

const DOC='<?xml version="1.0"?><!DOCTYPE doc><doc a="1" b=\'2\'>hi<![CDATA[<x>]]><!--c--><?p d?><e/></doc>';
const EVENTS:ParserEvent[]=[
  {type:'start',name:'doc',attributes:[{name:'a',value:'1'},{name:'b',value:'2'}],selfClosing:false},
  {type:'text',data:'hi'},
  {type:'text',data:'<x>'},
  {type:'comment',data:'c'},
  {type:'pi',target:'p',data:'d'},
  {type:'start',name:'e',attributes:[],selfClosing:true},
  {type:'end',name:'e'},
  {type:'end',name:'doc'},
];

describe('XMLStreamParser',()=>{
  it('parses a full document into events',()=>{
    expect(collect([DOC])).toEqual(EVENTS);
  });
  it('is chunk-boundary independent',()=>{
    const expected=merged(EVENTS);
    for(let i=0;i<=DOC.length;i++)
      expect(merged(collect([DOC.slice(0,i),DOC.slice(i)])),`split at ${i}`).toEqual(expected);
  });
  it('decodes UTF-8 bytes split across chunks',()=>{
    const bytes=new TextEncoder().encode('<doc>日本語 ✓</doc>');
    const events=merged(collect([...bytes].map(b=>new Uint8Array([b]))));
    expect(events).toEqual([
      {type:'start',name:'doc',attributes:[],selfClosing:false},
      {type:'text',data:'日本語 ✓'},
      {type:'end',name:'doc'},
    ]);
  });
  it('normalizes CRLF and CR in text, attributes and comments',()=>{
    expect(collect(['<doc a="x\r\ny">1\r2\r\n3<!--l\r\nm--></doc>'])).toEqual([
      {type:'start',name:'doc',attributes:[{name:'a',value:'x y'}],selfClosing:false},
      {type:'text',data:'1\n2\n3'},
      {type:'comment',data:'l\nm'},
      {type:'end',name:'doc'},
    ]);
  });
  it('normalizes literal whitespace in attribute values but keeps referenced whitespace',()=>{
    expect(collect(['<doc a="p\tq\nr&#x9;s&#xA;t&#xD;u"/>'])).toEqual([
      {type:'start',name:'doc',attributes:[{name:'a',value:'p q r\ts\nt\ru'}],selfClosing:true},
      {type:'end',name:'doc'},
    ]);
  });
  it('expands predefined entities and character references',()=>{
    expect(collect(['<doc>&lt;&gt;&amp;&apos;&quot;&#65;&#x42;&#x1F600;</doc>'])).toEqual([
      {type:'start',name:'doc',attributes:[],selfClosing:false},
      {type:'text',data:`<>&'\"AB\u{1F600}`},
      {type:'end',name:'doc'},
    ]);
  });
  it('rejects invalid input',()=>{
    expect(fail(['<a></b>']).message).toMatch(/mismatched end tag/);
    expect(fail(['<a>']).message).toMatch(/unclosed element/);
    expect(fail(['<a/><b/>']).message).toMatch(/multiple root elements/);
    expect(fail(['x<a/>']).message).toMatch(/outside the root element/);
    expect(fail(['<a/>x']).message).toMatch(/outside the root element/);
    expect(fail(['<a x="1" x="2"/>']).message).toMatch(/duplicate attribute "x"/);
    expect(fail(['<a><!-- x -- y --></a>']).message).toMatch(/must not contain "--"/);
    expect(fail(['<a>&foo;</a>']).message).toMatch(/undefined entity/);
    expect(fail(['<a>&amp</a>']).message).toMatch(/unterminated entity/);
    expect(fail(['<a>&#xD800;</a>']).message).toMatch(/invalid character reference/);
    expect(fail(['<a>&#0;</a>']).message).toMatch(/invalid character reference/);
    expect(fail(['<a x="1<2"/>']).message).toMatch(/not allowed in attribute/);
    expect(fail(['<a>]]></a>']).message).toMatch(/not allowed in character data/);
    expect(fail(['<a><b</a>']).message).toMatch(/malformed|truncated|mismatched/);
    expect(fail(['<a></a></a>']).message).toMatch(/unexpected end tag/);
    expect(fail(['']).message).toMatch(/no root element/);
    expect(fail(['<a/><!DOCTYPE d>']).message).toMatch(/DOCTYPE must precede/);
    expect(fail(['<!DOCTYPE d [<!ENTITY e "v">]><a/>']).message).toMatch(/internal subset/);
    expect(fail(['<a><?xml v?></a>']).message).toMatch(/must be the very first/);
    expect(fail(['<?xml encoding="latin1"?><a/>']).message).toMatch(/unsupported encoding/);
    expect(fail(['<a><?xMl?></a>']).message).toMatch(/invalid PI target/);
    expect(fail(['<1a/>']).message).toMatch(/invalid name/);
    expect(fail(['<a b:c:d="1"/>']).message).toMatch(/invalid qualified name/);
  });
  it('rejects invalid UTF-8',()=>{
    expect(fail([new Uint8Array([0x3c,0x61,0x3e,0xff,0x3c,0x2f,0x61,0x3e])]).message).toBeTruthy();
  });
});
