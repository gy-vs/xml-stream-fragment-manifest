import{describe,expect,it}from'vitest';
import{createHash}from'node:crypto';
import{
  canonicalForm,
  canonicalizeFragments,
  digestFragments,
  digestSubtree,
  FragmentCanonicalizer,
  FragmentDigestHandler,
  FragmentTextHandler,
  XMLStreamParser,
  utf8ByteLength,
  type FragmentHandler,
  type FragmentHeader,
  type FragmentStream,
}from'../src/index.js';

declare const gc:undefined|(()=>void);

const enc=new TextEncoder();
function* splitEvery(xml:string,n:number):Generator<Uint8Array>{
  const bytes=enc.encode(xml);
  for(let i=0;i<bytes.length;i+=n)yield bytes.slice(i,i+n);
}
const twoWaySplits=(xml:string):string[][]=>
  Array.from({length:xml.length+1},(_,i)=>[xml.slice(0,i),xml.slice(i)]);

describe('per-fragment identity',()=>{
  const xml='<root><sec><item id="1">a</item><item id="2">b</item></sec><item id="3">c</item></root>';

  it('returns one result per hit, in document start order, with path and sibling position',()=>{
    const rs=digestFragments(xml,{select:'//item'});
    expect(rs.map(r=>r.pathString)).toEqual([
      '/root/sec/item',
      '/root/sec/item[2]',
      '/root/item',
    ]);
    expect(rs.map(r=>r.index)).toEqual([0,1,2]);
    expect(rs.map(r=>r.path.map(s=>s.name))).toEqual([
      ['root','sec','item'],
      ['root','sec','item'],
      ['root','item'],
    ]);
    expect(rs.map(r=>r.path.at(-1)!.position)).toEqual([1,2,1]);
  });

  it('positions same-local-name siblings by expanded name, not lexical spelling',()=>{
    const ns='<r xmlns="urn:d" xmlns:p="urn:p"><x/><p:x/><x/></r>';
    const rs=digestFragments(ns,{select:'//x'}); // unprefixed step matches any namespace
    expect(rs.map(r=>r.pathString)).toEqual(['/r/x','/r/p:x','/r/x[2]']);
    expect(rs.map(r=>r.path.at(-1)!.uri)).toEqual(['urn:d','urn:p','urn:d']);
  });

  it('reports an explicit empty list when nothing matches',()=>{
    expect(digestFragments(xml,{select:'//absent'})).toEqual([]);
    expect(digestFragments(xml,{select:'/root/nope/x'})).toEqual([]);
  });

  it('canonicalizes a self-closing hit like the single-output canonicalizer',()=>{
    const h=new FragmentTextHandler();
    canonicalizeFragments('<root><a/></root>',{select:'//a'},h);
    expect(h.fragments.map(f=>f.text)).toEqual(['<a></a>']);
  });
});

describe('fragment content cross-checks',()=>{
  // Each target sits under a uniquely named structural branch, so an absolute
  // path selects exactly that one subtree: the fragment must equal the result
  // of the existing single-target canonicalForm/digestSubtree on the same bytes.
  const xml='<root><s1><item id="1">a</item></s1><s2><item id="2"><k>b</k></item></s2><s3><item id="3">c</item></s3></root>';

  it('every fragment text matches the standalone canonicalForm of its own absolute path',()=>{
    const h=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//item'},h);
    expect(h.fragments.map(f=>f.header.pathString)).toEqual([
      '/root/s1/item','/root/s2/item','/root/s3/item',
    ]);
    for(const f of h.fragments){
      const select='/'+f.header.path.map(s=>s.name).join('/');
      expect(f.text,select).toBe(canonicalForm(xml,{select}));
    }
  });

  it('bytes is the UTF-8 length of exactly that fragment, and digest is over those bytes',()=>{
    const h=new FragmentTextHandler();
    const d=new FragmentDigestHandler();
    canonicalizeFragments(xml,{select:'//item'},{
      open(header){const a=h.open(header);const b=d.open(header);return{write:c=>{a.write(c);b.write(c)},close:x=>{a.close(x);b.close(x)}}},
    });
    expect(h.fragments.length).toBe(d.results.length);
    for(let i=0;i<h.fragments.length;i++){
      const f=h.fragments[i]!,r=d.results[i]!;
      expect(r.pathString).toBe(f.header.pathString);
      expect(r.bytes).toBe(Buffer.byteLength(f.text,'utf8'));
      expect(r.bytes).toBe(utf8ByteLength(f.text));
      expect(r.digest).toBe(createHash('sha256').update(f.text,'utf8').digest('hex'));
      const select='/'+f.header.path.map(s=>s.name).join('/');
      expect(r.digest).toBe(digestSubtree(xml,{select}));
    }
  });

  it('counts multibyte UTF-8 content in bytes, not code units',()=>{
    const rs=digestFragments('<root><d>日本語 ✓</d></root>',{select:'//d'});
    // '<d>' + 3*3 + 1 + 3 + '</d>' == 3+9+1+3+4
    expect(rs[0]!.bytes).toBe('<d>'.length+3*3+1+3+'</d>'.length);
  });

  it('matches digestSubtree for a document containing only that target',()=>{
    const one='<root><item id="1">a</item></root>';
    expect(digestFragments(one,{select:'//item'})[0]!.digest)
      .toBe(digestSubtree(one,{select:'/root/item'}));
  });
});

describe('nested and repeated hits',()=>{
  const xml='<root><a>outer<a>inner</a>tail</a><a>sib</a></root>';

  it('emits both outer and inner hits with independent text and digest',()=>{
    const h=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//a'},h);
    expect(h.fragments.map(f=>f.header.pathString)).toEqual(['/root/a','/root/a/a','/root/a[2]']);
    expect(h.fragments.map(f=>f.text)).toEqual([
      '<a>outer<a>inner</a>tail</a>',
      '<a>inner</a>',
      '<a>sib</a>',
    ]);
    const digests=new Set(digestFragments(xml,{select:'//a'}).map(r=>r.digest));
    expect(digests.size).toBe(3);
  });

  it('inner fragment is byte-identical to standalone canonicalization of the inner subtree',()=>{
    const inner='<root><a>inner</a></root>';
    const h=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//a'},h);
    expect(h.fragments[1]!.text).toBe(canonicalForm(inner,{select:'/root/a'}));
    expect(digestFragments(xml,{select:'//a'})[1]!.digest)
      .toBe(digestSubtree(inner,{select:'/root/a'}));
  });

  it('outer fragment is byte-identical to standalone canonicalization of the outer subtree',()=>{
    const outer='<root><a>outer<a>inner</a>tail</a></root>';
    const h=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//a'},h);
    expect(h.fragments[0]!.text).toBe(canonicalForm(outer,{select:'/root/a'}));
  });

  it('closes nested fragments innermost-first while results remain start-ordered',()=>{
    const opens:number[]=[],closes:number[]=[];
    canonicalizeFragments(xml,{select:'//a'},{
      open:h=>{opens.push(h.index);return{write(){},close:x=>closes.push(x.index)}},
    });
    expect(opens).toEqual([0,1,2]);
    expect(closes).toEqual([1,0,2]); // inner closes before outer; sibling after
    expect(digestFragments(xml,{select:'//a'}).map(r=>r.index)).toEqual([0,1,2]);
  });

  it('gives identical repeated hits identical digests',()=>{
    const rep='<root><x>v</x><x>v</x><other><x>v</x></other></root>';
    expect(new Set(digestFragments(rep,{select:'//x'}).map(r=>r.digest)).size).toBe(1);
  });
});

describe('namespace semantics per fragment',()=>{
  it('redeclares a prefix inherited from an ancestor as if targeted standalone',()=>{
    const xml='<root xmlns:p="urn:p"><sub><p:leaf p:attr="v">t</p:leaf></sub></root>';
    const h=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//leaf'},h);
    const text=h.fragments[0]!.text;
    expect(text).toBe('<p:leaf xmlns:p="urn:p" p:attr="v">t</p:leaf>');
    expect(text).toBe(canonicalForm(xml,{select:'/root/sub/p:leaf',namespaces:{p:'urn:p'}}));
  });

  it('renders inherited default namespace per independent fragment',()=>{
    const xml='<root xmlns="urn:d"><child><leaf>x</leaf></child></root>';
    const h=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//leaf'},h);
    expect(h.fragments[0]!.text).toBe('<leaf xmlns="urn:d">x</leaf>');
  });

  it('keeps outer and inner namespace contexts independent across nested matches',()=>{
    const xml='<root xmlns:p="urn:1"><a><p:x>v</p:x><a xmlns:p="urn:2"><p:y>w</p:y></a></a></root>';
    const h=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//a'},h);
    const[outer,inner]=h.fragments.map(f=>f.text);
    // outer stream: the rebinding is rendered at the first element that visibly
    // utilizes it (p:y), not at the inner <a>; exclusive-c14n placement rule
    expect(outer).toBe('<a><p:x xmlns:p="urn:1">v</p:x><a><p:y xmlns:p="urn:2">w</p:y></a></a>');
    expect(inner).toBe('<a><p:y xmlns:p="urn:2">w</p:y></a>');
    // inner must equal its own standalone form under the same inherited binding
    const standalone='<doc xmlns:p="urn:2"><a><p:y>w</p:y></a></doc>';
    expect(inner).toBe(canonicalForm(standalone,{select:'//a'}));
    // outer must equal standalone canonicalization of the whole outer subtree
    expect(outer).toBe(canonicalForm(xml,{select:'/root/a'}));
  });
});

describe('shared canonicalization options per fragment',()=>{
  it('sorts attributes, applies text/attribute escaping, and expands CDATA per fragment',()=>{
    const xml='<root><item zz="2" b="1">1&lt;2 &amp; <![CDATA[3>2]]></item></root>';
    const h=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//item'},h);
    expect(h.fragments[0]!.text).toBe('<item b="1" zz="2">1&lt;2 &amp; 3&gt;2</item>');
  });

  it('drops comments by default and keeps them with withComments inside each fragment',()=>{
    const xml='<root><a>x<!--c--><b/></a><a><!--d-->y</a></root>';
    expect(digestFragments(xml,{select:'//a'}).length).toBe(2);
    const off=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//a'},off);
    expect(off.fragments.map(f=>f.text)).toEqual(['<a>x<b></b></a>','<a>y</a>']);
    const on=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//a',withComments:true},on);
    expect(on.fragments.map(f=>f.text)).toEqual(['<a>x<!--c--><b></b></a>','<a><!--d-->y</a>']);
  });

  it('keeps processing instructions inside fragments and ignores them outside',()=>{
    const xml='<?top?><root><a><?go data?>x</a></root><!--tail-->';
    const h=new FragmentTextHandler();
    canonicalizeFragments(xml,{select:'//a',withComments:true},h);
    expect(h.fragments[0]!.text).toBe('<a><?go data?>x</a>');
  });
});

describe('chunk-boundary independence',()=>{
  const xml='<root xmlns:p="urn:p"><a><item id="1">日本語 ✓</item><item id="2"><![CDATA[a<b&amp;]]></item>'
    +'<a>nested<a>deep</a></a></a></root>';

  it('paths, bytes and digests are identical for whole-string, byte-wise and every 2-way split',()=>{
    const opts={select:'//item'} as const;
    const base=digestFragments(xml,opts);
    const byByte=digestFragments(splitEvery(xml,1),opts);
    expect(byByte).toEqual(base);
    for(const parts of twoWaySplits(xml)){
      const got=digestFragments(parts,opts);
      expect(got.map(r=>r.pathString)).toEqual(base.map(r=>r.pathString));
      expect(got.map(r=>r.bytes)).toEqual(base.map(r=>r.bytes));
      expect(got.map(r=>r.digest)).toEqual(base.map(r=>r.digest));
    }
  });

  it('is stable under byte splits for nested same-name matches and comments',()=>{
    const opts={select:'//a',withComments:true} as const;
    const base=digestFragments(xml,opts);
    for(const parts of[splitEvery(xml,1),splitEvery(xml,3),...twoWaySplits(xml)])
      expect(digestFragments(parts,opts)).toEqual(base);
  });
});

describe('failure semantics',()=>{
  it('throws on malformed XML instead of returning a partial fragment list',()=>{
    expect(()=>digestFragments('<root><a>x</b></root>',{select:'//a'})).toThrow(/mismatched/);
    expect(()=>digestFragments('<root><a>x</root>',{select:'//a'})).toThrow();
    expect(()=>digestFragments('<root/><a/>',{select:'//a'})).toThrow(/multiple root/);
  });

  it('throws on invalid namespaces even when the offending element is not a hit',()=>{
    expect(()=>digestFragments('<root><other><p:x/></other><a/></root>',{select:'//a'}))
      .toThrow(/unbound prefix "p"/);
    expect(()=>digestFragments('<root xmlns:p=""><a/></root>',{select:'//a'})).toThrow(/undeclare/);
  });

  it('rejects bad selectors at construction time',()=>{
    expect(()=>new FragmentCanonicalizer({select:'a'},{open:()=>({})}))
      .toThrow(/must start with/);
    expect(()=>digestFragments('<a/>',{select:'/p:x',namespaces:{}})).toThrow(/unknown prefix/);
  });
});

describe('incremental handler contract',()=>{
  it('opens before writes, routes only same-fragment bytes, and closes exactly once',()=>{
    const events:string[]=[];
    const handler:FragmentHandler={
      open(header:FragmentHeader):FragmentStream{
        events.push(`open ${header.index} ${header.pathString}`);
        return{
          write:chunk=>events.push(`write ${header.index} ${chunk.length}`),
          close:h=>events.push(`close ${h.index}`),
        };
      },
    };
    canonicalizeFragments('<root><a>xy<a>z</a></a><a/></root>',{select:'//a'},handler);
    expect(events[0]).toBe('open 0 /root/a');
    expect(events).toContain('open 1 /root/a/a');
    expect(events).toContain('close 1');
    expect(events.filter(e=>e.startsWith('close'))).toEqual(['close 1','close 0','close 2']);
    // no write may carry bytes for two tags of different fragments merged:
    // the outer stream writes <a> ... <a>z</a> ... </a> as separate chunks
    const outerWrites=events.filter(e=>e.startsWith('write 0'));
    expect(outerWrites.length).toBeGreaterThanOrEqual(4);
  });

  it('plugs into XMLStreamParser with UTF-8 chunks, like the public Canonicalizer chain',()=>{
    const d=new FragmentDigestHandler();
    const canonicalizer=new FragmentCanonicalizer({select:'//a'},d);
    const parser=new XMLStreamParser(e=>canonicalizer.handle(e));
    const bytes=new TextEncoder().encode('<root><a>x</a><a>y</a></root>');
    for(let i=0;i<bytes.length;i+=5)parser.feed(bytes.slice(i,i+5));
    parser.end();
    expect(d.results.map(r=>r.pathString)).toEqual(['/root/a','/root/a[2]']);
  });
});

describe('memory on long streams',()=>{
  it('retained heap does not grow linearly with document size',()=>{
    if(typeof gc!=='function')return; // --expose-gc unavailable in this runner
    const N=400000, repeat=50; // tens of MB, only one matched element
    const doc=function*(){
      yield '<root>';
      for(let i=0;i<N;i++){
        yield `<wrap${i%500}/><s>${'x'.repeat(repeat)}</s>`;
      }
      yield '<hit>z</hit></root>';
    };
    gc();gc();
    const before=process.memoryUsage().heapUsed;
    const d=new FragmentDigestHandler();
    const canonicalizer=new FragmentCanonicalizer({select:'//hit'},d);
    const parser=new XMLStreamParser(e=>canonicalizer.handle(e));
    for(const ch of doc())parser.feed(ch);
    parser.end();
    gc();gc();
    const after=process.memoryUsage().heapUsed;
    const payload=N*(14+repeat);
    expect(d.results).toHaveLength(1);
    expect(after-before).toBeLessThan(payload/10); // < ~2.5 MB for ~25 MB streamed
  });

  it('streams content incrementally without accumulating a subtree-sized buffer',()=>{
    let maxWrite=0;
    canonicalizeFragments(function*(){
      yield '<root>';
      for(let i=0;i<10000;i++)yield `<a>${i}</a>`; // 10000 tiny matched subtrees
      yield '</root>';
    }(),{select:'//a'},{
      open(h){
        let seen=0;
        return{write:c=>{maxWrite=Math.max(maxWrite,c.length);seen+=c.length},
          close(){expect(seen).toBeLessThan(40)}};
      },
    });
    expect(maxWrite).toBeLessThan(40); // token-sized writes regardless of document length
  });
});
