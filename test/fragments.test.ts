import{describe,expect,it}from'vitest';
import{
  canonicalForm,
  canonicalFragments,
  digestFragments,
  digestSubtree,
  FragmentCanonicalizer,
  HashSink,
  XMLStreamParser,
}from'../src/index.js';

const pathsOf=(r:{path:string}[]):string[]=>r.map(f=>f.path);

describe('per-fragment results',()=>{
  it('returns an independent result per repeated hit in start order',()=>{
    const xml='<root><a>one</a><b>x</b><a>two</a></root>';
    const r=digestFragments(xml,{select:'//a'});
    expect(pathsOf(r)).toEqual(['/root[1]/a[1]','/root[1]/a[2]']);
    expect(r.map(f=>f.index)).toEqual([0,1]);
    expect(r[0].digest).not.toBe(r[1].digest);
    const cf=canonicalFragments(xml,{select:'//a'});
    expect(cf.map(f=>f.sink.text)).toEqual(['<a>one</a>','<a>two</a>']);
  });

  it('reports element path and 1-based same-name sibling position',()=>{
    const xml='<r><x>1<a><a>deep</a></a></x><x>2<a/></x></r>';
    const r=digestFragments(xml,{select:'//a'});
    expect(pathsOf(r)).toEqual(['/r[1]/x[1]/a[1]','/r[1]/x[1]/a[1]/a[1]','/r[1]/x[2]/a[1]']);
    expect(r[1].steps).toEqual([
      {name:'r',position:1},{name:'x',position:1},{name:'a',position:1},{name:'a',position:1},
    ]);
  });

  it('counts only same-named siblings for position',()=>{
    const xml='<r><b/><a/><b/><a/></r>';
    const r=digestFragments(xml,{select:'//a'});
    expect(pathsOf(r)).toEqual(['/r[1]/a[1]','/r[1]/a[2]']);
  });

  it('gives nested same-name hits separate, non-mixed results',()=>{
    const xml='<a>outer<a>inner</a></a>';
    const r=digestFragments(xml,{select:'//a'});
    expect(pathsOf(r)).toEqual(['/a[1]','/a[1]/a[1]']);
    expect(r[0].digest).not.toBe(r[1].digest);
    const cf=canonicalFragments(xml,{select:'//a'});
    expect(cf[0].sink.text).toBe('<a>outer<a>inner</a></a>');
    expect(cf[1].sink.text).toBe('<a>inner</a>');
    expect(cf[0].bytes).toBe(Buffer.byteLength(cf[0].sink.text,'utf8'));
    expect(cf[1].bytes).toBe(Buffer.byteLength(cf[1].sink.text,'utf8'));
  });

  it('matches identical siblings with equal digests but distinct paths',()=>{
    const r=digestFragments('<r><a>x</a><a>x</a></r>',{select:'//a'});
    expect(r[0].digest).toBe(r[1].digest);
    expect(r[0].path).not.toBe(r[1].path);
  });

  it('reports empty results explicitly when nothing matches',()=>{
    expect(digestFragments('<root><a/></root>',{select:'/root/zzz'})).toEqual([]);
    expect(canonicalFragments('<root><a/></root>',{select:'//zzz'})).toEqual([]);
  });

  it('works for self-closing matched elements',()=>{
    const r=canonicalFragments('<root><a/><a/></root>',{select:'//a'});
    expect(r.map(f=>f.sink.text)).toEqual(['<a></a>','<a></a>']);
  });
});

describe('per-fragment cross-check against single-subtree API',()=>{
  it('equals canonicalForm/digestSubtree for the element targeted on its own',()=>{
    const xml='<root xmlns:p="urn:p"><a id="1">x<p:e>mid<a id="2">deep</a></p:e></a></root>';
    const all=digestFragments(xml,{select:'//a'});
    const inner=all.find(f=>f.path==='/root[1]/a[1]/p:e[1]/a[1]')!;
    expect(inner.digest).toBe(digestSubtree(xml,{select:'/root/a/p:e/a',namespaces:{p:'urn:p'}}));
    const cf=canonicalFragments(xml,{select:'//a'}).find(f=>f.index===inner.index)!;
    expect(cf.sink.text).toBe(canonicalForm(xml,{select:'/root/a/p:e/a',namespaces:{p:'urn:p'}}));
    expect(cf.bytes).toBe(Buffer.byteLength(cf.sink.text,'utf8'));
  });

  it('re-renders namespaces inherited from ancestors as a standalone target would',()=>{
    const xml='<root xmlns:p="urn:p"><sub><p:leaf p:attr="v"/></sub></root>';
    const r=canonicalFragments(xml,{select:'//p:leaf',namespaces:{p:'urn:p'}});
    expect(r).toHaveLength(1);
    expect(r[0].sink.text).toBe('<p:leaf xmlns:p="urn:p" p:attr="v"></p:leaf>');
    expect(r[0].sink.text).toBe(canonicalForm(xml,{select:'/root/sub/p:leaf',namespaces:{p:'urn:p'}}));
  });

  it('keeps each nested result in its own namespace context',()=>{
    const xml='<root xmlns:p="urn:1"><p:a><p:a>inner</p:a></p:a></root>';
    const cf=canonicalFragments(xml,{select:'//p:a',namespaces:{p:'urn:1'}});
    expect(cf[0].sink.text).toBe('<p:a xmlns:p="urn:1"><p:a>inner</p:a></p:a>');
    expect(cf[1].sink.text).toBe('<p:a xmlns:p="urn:1">inner</p:a>');
  });

  it('honours withComments, escaping and attribute ordering per fragment',()=>{
    const xml='<root xmlns:z="urn:z"><item z:b="2" b="1"><!--c-->a&amp;b</item><item>x</item></root>';
    const dropped=canonicalFragments(xml,{select:'//item'});
    // the standalone result re-renders the inherited, visibly-utilized z binding
    expect(dropped[0].sink.text).toBe('<item xmlns:z="urn:z" b="1" z:b="2">a&amp;b</item>');
    const kept=canonicalFragments(xml,{select:'//item',withComments:true});
    expect(kept[0].sink.text).toBe('<item xmlns:z="urn:z" b="1" z:b="2"><!--c-->a&amp;b</item>');
    // bytes are counted independently on UTF-8 output
    const utf8='<root><item>日本語</item></root>';
    const r=digestFragments(utf8,{select:'//item'})[0];
    expect(r.bytes).toBe(Buffer.byteLength('<item>日本語</item>','utf8'));
  });
});

describe('per-fragment streaming',()=>{
  it('drives the public XMLStreamParser -> FragmentCanonicalizer -> HashSink chain',()=>{
    const opened:string[]=[];
    const closed:{path:string;digest:string}[]=[];
    const fc=new FragmentCanonicalizer<HashSink>({select:'//item'},{
      open:meta=>{opened.push(meta.path);return new HashSink()},
      close:(meta,sink)=>closed.push({path:meta.path,digest:sink.digest()}),
    });
    // Wrap each hit in a uniquely-named parent so the simple selector language
    // can target each subtree exactly once for the cross-check.
    const xml='<root><first><item>a</item></first><second><item><item>b</item></item></second></root>';
    const bytes=new TextEncoder().encode(xml);
    const parser=new XMLStreamParser(e=>fc.handle(e));
    for(let i=0;i<bytes.length;i+=7)parser.feed(bytes.slice(i,i+7));
    parser.end();
    expect(opened).toEqual([
      '/root[1]/first[1]/item[1]',
      '/root[1]/second[1]/item[1]',
      '/root[1]/second[1]/item[1]/item[1]',
    ]);
    // closes arrive LIFO; callers compare by path/index. Compare against the
    // single-subtree API using selectors that uniquely identify each element.
    const byPath=Object.fromEntries(closed.map(c=>[c.path,c.digest]));
    expect(byPath['/root[1]/first[1]/item[1]']).toBe(digestSubtree(xml,{select:'/root/first/item'}));
    expect(byPath['/root[1]/second[1]/item[1]/item[1]']).toBe(digestSubtree(xml,{select:'/root/second/item/item'}));
  });

  it('is independent of input chunk boundaries (string and UTF-8 byte splits)',()=>{
    const xml='<root xmlns:p="urn:p"><item id="1">a&amp;b 日本語<!--c--></item>'+
      '<item id="2"><n:a xmlns:n="urn:n" n:x="1"><item id="3">deep\r\nx</item></n:a></item></root>';
    const opts={select:'//item',withComments:true}as const;
    const whole=digestFragments(xml,opts);
    for(let i=0;i<xml.length;i++)
      expect(digestFragments([xml.slice(0,i),xml.slice(i)],opts),`split at ${i}`).toEqual(whole);
    const bytes=new TextEncoder().encode(xml);
    expect(digestFragments([...bytes].map(b=>new Uint8Array([b])),opts)).toEqual(whole);
    for(const size of[1,2,3,7,13,64]){
      const chunks=[];
      for(let i=0;i<bytes.length;i+=size)chunks.push(bytes.slice(i,i+size));
      expect(digestFragments(chunks,opts),`chunk size ${size}`).toEqual(whole);
    }
  });

  it('does not share mutable selection state between sibling matches',()=>{
    // Each frame carries its own continuations; a failing branch must not poison a sibling.
    const xml='<r><a><miss/><b>1</b></a><a><b>2</b></a></r>';
    const r=digestFragments(xml,{select:'/r/a/b'});
    expect(pathsOf(r)).toEqual(['/r[1]/a[1]/b[1]','/r[1]/a[2]/b[1]']);
  });
});

describe('per-fragment failures',()=>{
  it('throws on invalid XML without returning a partial inventory',()=>{
    expect(()=>digestFragments('<a><b></a>',{select:'//b'})).toThrow(/mismatched end tag/);
    expect(()=>digestFragments('<a><b>x</b>',{select:'//b'})).toThrow(/unclosed element/);
    expect(()=>digestFragments('<a>&foo;</a>',{select:'//a'})).toThrow(/undefined entity/);
  });
  it('throws on invalid namespaces',()=>{
    expect(()=>digestFragments('<p:a/>',{select:'//a'})).toThrow(/unbound prefix "p"/);
    expect(()=>digestFragments('<a xmlns:p=""/>',{select:'//a'})).toThrow(/cannot undeclare/);
  });
  it('throws on invalid UTF-8 chunks',()=>{
    expect(()=>digestFragments([new Uint8Array([0x3c,0x61,0x3e,0xff,0x3c,0x2f,0x61,0x3e])],{select:'//a'}))
      .toThrow();
  });
});
