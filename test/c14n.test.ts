import{describe,expect,it}from'vitest';
import{canonicalForm,canonicalize,digestSubtree,HashSink,Canonicalizer,XMLStreamParser}from'../src/index.js';

const c14n=(xml:string|Iterable<string|Uint8Array>,select:string,extra:{namespaces?:Record<string,string>;withComments?:boolean}={}):string=>
  canonicalForm(xml,{select,...extra});

describe('selector',()=>{
  it('selects an absolute path',()=>{
    expect(c14n('<root><a/><b><c>x</c></b></root>','/root/b/c')).toBe('<c>x</c>');
  });
  it('selects descendants with //',()=>{
    expect(c14n('<root><a><b>1</b></a><b>2</b></root>','//b')).toBe('<b>1</b><b>2</b>');
  });
  it('emits nothing when nothing matches',()=>{
    expect(c14n('<root><a/></root>','/root/zzz')).toBe('');
  });
  it('matches an unprefixed step against any namespace',()=>{
    expect(c14n('<r xmlns:n="urn:n"><n:x/></r>','//x')).toBe('<n:x xmlns:n="urn:n"></n:x>');
  });
  it('resolves prefixed steps via the namespaces option',()=>{
    expect(c14n('<r xmlns:n="urn:n"><n:x/></r>','/r/n:x',{namespaces:{n:'urn:n'}})).toBe('<n:x xmlns:n="urn:n"></n:x>');
    expect(c14n('<r xmlns:n="urn:n"><n:x/></r>','/r/m:x',{namespaces:{m:'urn:m'}})).toBe('');
  });
  it('supports wildcard steps',()=>{
    expect(c14n('<r xmlns:n="urn:n"><n:x/><y/></r>','/r/*')).toBe('<n:x xmlns:n="urn:n"></n:x><y></y>');
  });
  it('emits a nested match only once, as part of its ancestor',()=>{
    expect(c14n('<root><a><a>inner</a></a></root>','//a')).toBe('<a><a>inner</a></a>');
  });
  it('rejects bad selectors',()=>{
    expect(()=>c14n('<a/>','a')).toThrow(/must start with/);
    expect(()=>c14n('<a/>','/')).toThrow(/selects nothing/);
    expect(()=>c14n('<a/>','/a//b')).toThrow(/empty step/);
    expect(()=>c14n('<a/>','/p:a')).toThrow(/unknown prefix/);
  });
});

describe('namespace canonicalization',()=>{
  it('redeclares prefixes inherited from outside the subtree',()=>{
    expect(c14n('<root xmlns:p="urn:p"><sub><p:leaf p:attr="v"/></sub></root>','/root/sub/p:leaf',{namespaces:{p:'urn:p'}}))
      .toBe('<p:leaf xmlns:p="urn:p" p:attr="v"></p:leaf>');
  });
  it('declares a prefix at the element that first needs it, not the apex',()=>{
    expect(c14n('<root xmlns:p="urn:p"><sub><leaf p:a="1"/></sub></root>','//sub'))
      .toBe('<sub><leaf xmlns:p="urn:p" p:a="1"></leaf></sub>');
  });
  it('renders the default namespace when an unprefixed element uses it',()=>{
    expect(c14n('<root xmlns="urn:d"><child/></root>','//child')).toBe('<child xmlns="urn:d"></child>');
  });
  it('renders xmlns="" when the default namespace is undeclared inside the selection',()=>{
    expect(c14n('<root xmlns="urn:d"><sub xmlns=""><leaf/></sub></root>','/root'))
      .toBe('<root xmlns="urn:d"><sub xmlns=""><leaf></leaf></sub></root>');
  });
  it('omits declarations that are not visibly utilized',()=>{
    expect(c14n('<root xmlns:unused="urn:u"><p:a xmlns:p="urn:p"/></root>','//p:a',{namespaces:{p:'urn:p'}}))
      .toBe('<p:a xmlns:p="urn:p"></p:a>');
    expect(c14n('<root xmlns:unused="urn:u"><p:a xmlns:p="urn:p"/></root>','/root'))
      .toBe('<root><p:a xmlns:p="urn:p"></p:a></root>');
  });
  it('omits an unused default namespace declaration',()=>{
    expect(c14n('<p:a xmlns:p="urn:p" xmlns="urn:d"/>','//p:a',{namespaces:{p:'urn:p'}}))
      .toBe('<p:a xmlns:p="urn:p"></p:a>');
  });
  it('does not repeat a binding already in the output context, but re-renders a rebound one',()=>{
    const xml='<root xmlns:p="urn:1"><a><p:x/><b xmlns:p="urn:2"><p:y/></b><p:z/></a></root>';
    expect(c14n(xml,'/root/a'))
      .toBe('<a><p:x xmlns:p="urn:1"></p:x><b><p:y xmlns:p="urn:2"></p:y></b><p:z xmlns:p="urn:1"></p:z></a>');
  });
  it('never declares the xml prefix',()=>{
    expect(c14n('<doc xml:lang="en" xml:space="preserve"/>','/doc'))
      .toBe('<doc xml:lang="en" xml:space="preserve"></doc>');
  });
  it('does not apply the default namespace to unprefixed attributes',()=>{
    // b has no namespace and therefore sorts before z:a (urn:z)
    expect(c14n('<doc xmlns="urn:d" xmlns:z="urn:z" b="1" z:a="2"/>','/doc'))
      .toBe('<doc xmlns="urn:d" xmlns:z="urn:z" b="1" z:a="2"></doc>');
  });
});

describe('attribute canonicalization',()=>{
  it('sorts attributes by namespace URI then local name, declarations first',()=>{
    const xml='<root xmlns:z="urn:z" xmlns:a="urn:a"><item z:b="2" a:b="1" plain="0" zz="9">t</item></root>';
    expect(c14n(xml,'/root/item')).toBe('<item xmlns:a="urn:a" xmlns:z="urn:z" plain="0" zz="9" a:b="1" z:b="2">t</item>');
  });
  it('rejects duplicate attributes',()=>{
    expect(()=>c14n('<doc x="1" x="2"/>','/doc')).toThrow(/duplicate attribute "x"/);
    expect(()=>c14n('<doc xmlns:a="urn:u" xmlns:b="urn:u" a:x="1" b:x="2"/>','/doc')).toThrow(/duplicate attribute "b:x"/);
  });
  it('rejects unbound prefixes and prefix undeclaration',()=>{
    expect(()=>c14n('<p:a/>','/p:a',{namespaces:{p:'urn:p'}})).toThrow(/unbound prefix "p"/);
    expect(()=>c14n('<doc xmlns:p=""/>','/doc')).toThrow(/cannot undeclare/);
  });
});

describe('text and escaping',()=>{
  it('escapes text per c14n rules',()=>{
    expect(c14n('<doc>1&lt;2 &amp; 3&gt;2&#xD;end</doc>','/doc')).toBe('<doc>1&lt;2 &amp; 3&gt;2&#xD;end</doc>');
  });
  it('escapes attribute values per c14n rules',()=>{
    expect(c14n('<doc t="&quot;&lt;&amp;&#x9;&#xA;&#xD;"/>','/doc'))
      .toBe('<doc t="&quot;&lt;&amp;&#x9;&#xA;&#xD;"></doc>');
  });
  it('normalizes literal whitespace in attribute values to spaces',()=>{
    expect(c14n('<doc t="a\tb\nc"/>','/doc')).toBe('<doc t="a b c"></doc>');
  });
  it('replaces CDATA sections with their character content',()=>{
    expect(c14n('<doc><![CDATA[1 < 2 & 3]]></doc>','/doc')).toBe('<doc>1 &lt; 2 &amp; 3</doc>');
  });
  it('keeps mixed content whitespace',()=>{
    expect(c14n('<doc> <b/> </doc>','/doc')).toBe('<doc> <b></b> </doc>');
  });
});

describe('comments and processing instructions',()=>{
  const xml='<doc><!--note--><a/><?go some data?><?empty?></doc>';
  it('drops comments by default and keeps them with withComments',()=>{
    expect(c14n(xml,'/doc')).toBe('<doc><a></a><?go some data?><?empty?></doc>');
    expect(c14n(xml,'/doc',{withComments:true})).toBe('<doc><!--note--><a></a><?go some data?><?empty?></doc>');
  });
  it('ignores comments and PIs outside the selection',()=>{
    expect(c14n('<?top?><root><a/></root><!--tail-->','/root/a',{withComments:true})).toBe('<a></a>');
  });
});

describe('infoset equivalence',()=>{
  const pairs:[string,string][]=[
    ['<doc><a/></doc>','<doc><a></a></doc>'],
    ['<doc  x="1"   y="2" ></doc>','<doc y="2" x="1"></doc>'],
    ['<doc>M&amp;M</doc>','<doc><![CDATA[M&M]]></doc>'],
    ['<doc>a\r\nb</doc>','<doc>a\nb</doc>'],
    ['<doc>a\rb</doc>','<doc>a\nb</doc>'],
    ['<doc>&#65;&#x42;</doc>','<doc>AB</doc>'],
    ["<doc t='single &quot;q&quot;'/>",'<doc t="single &quot;q&quot;"></doc>'],
    ['<doc><![CDATA[]]></doc>','<doc></doc>'],
    ['<?xml version="1.0" encoding="UTF-8"?><doc/>','<doc/>'],
  ];
  it.each(pairs)('canonicalizes equal infosets identically: %s',(a,b)=>{
    const ca=c14n(a,'/doc'),cb=c14n(b,'/doc');
    expect(ca).toBe(cb);
    expect(digestSubtree(a,{select:'/doc'})).toBe(digestSubtree(b,{select:'/doc'}));
  });
  it('matches a known canonical form',()=>{
    expect(c14n('<doc  b="2" a="1">x<![CDATA[<y>]]>&amp;z</doc>','/doc'))
      .toBe('<doc a="1" b="2">x&lt;y&gt;&amp;z</doc>');
  });
});

describe('streaming',()=>{
  const xml='<root xmlns:p="urn:p"><item id="1">日本語 ✓</item><item id="2"><![CDATA[a<b]]></item></root>';
  const expected='<item id="1">日本語 ✓</item><item id="2">a&lt;b</item>';
  it('produces identical output for byte-wise feeding',()=>{
    expect(c14n(xml,'//item')).toBe(expected);
    const bytes=new TextEncoder().encode(xml);
    expect(c14n([...bytes].map(b=>new Uint8Array([b])),'//item')).toBe(expected);
  });
  it('produces identical output for splits inside tags, entities and CRLF',()=>{
    const tricky='<doc>a&amp;b\r\nc<![CDATA[d]]><!--x--></doc>';
    const whole=c14n(tricky,'/doc',{withComments:true});
    for(let i=0;i<tricky.length;i++)
      expect(c14n([tricky.slice(0,i),tricky.slice(i)],'/doc',{withComments:true}),`split at ${i}`).toBe(whole);
  });
  it('writes the digest sink incrementally and matches the one-shot digest',()=>{
    const sink=new HashSink();
    const writes:string[]=[];
    const canonicalizer=new Canonicalizer({select:'//item'},{write:c=>{writes.push(c);sink.write(c)}});
    const parser=new XMLStreamParser(e=>canonicalizer.handle(e));
    const bytes=new TextEncoder().encode(xml);
    for(let i=0;i<bytes.length;i+=7)parser.feed(bytes.slice(i,i+7));
    parser.end();
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.join('')).toBe(expected);
    expect(sink.digest()).toBe(digestSubtree(xml,{select:'//item'}));
  });
  it('matches a known sha256 vector',()=>{
    const xml='<root xmlns:p="urn:p"><p:a x="1">hi</p:a></root>';
    expect(c14n(xml,'/root')).toBe('<root><p:a xmlns:p="urn:p" x="1">hi</p:a></root>');
    expect(digestSubtree(xml,{select:'/root'})).toBe('7fe317733d53e017c757b2312335a167128a322308ce23417abb06db60737d40');
  });
  it('supports other digest algorithms and encodings',()=>{
    const sink=new HashSink('sha1');
    canonicalize('<doc/>',{select:'/doc'},sink);
    expect(sink.digest('base64')).toBe('sWoirPVay6TPlMhsQWYsrnhHirM=');
  });
});

describe('context is maintained before the selector hits',()=>{
  it('tracks namespaces through unselected ancestors',()=>{
    const xml='<a xmlns:p="urn:1"><b><c xmlns:p="urn:2"><d><p:e/></d></c></b></a>';
    expect(c14n(xml,'/a/b/c/d/p:e',{namespaces:{p:'urn:2'}})).toBe('<p:e xmlns:p="urn:2"></p:e>');
  });
});
