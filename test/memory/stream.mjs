// Memory-bound verification for per-fragment streaming.
// Run after `npm run build`: `node --expose-gc test/memory/stream.mjs`
import{FragmentCanonicalizer,XMLStreamParser}from'../../dist/index.js';

const MiB=1024*1024;

class ByteCounter{
  #n=0;
  write(chunk){this.#n+=Buffer.byteLength(chunk,'utf8')}
  get bytes(){return this.#n}
}

// Streams a document of `totalSize` bytes containing a fixed number of matched
// <item> subtrees. Results are dropped as soon as each subtree closes, so heap
// retention must depend on parser buffer + open element depth, not document size.
const run=(totalSize)=>{
  let count=0;
  const fc=new FragmentCanonicalizer({select:'//item'},{
    open:()=>new ByteCounter(),
    close:()=>{count++}, // result discarded immediately
  });
  const parser=new XMLStreamParser(e=>fc.handle(e));
  const items=20;
  // Yield the payload in small chunks: the generator never holds the document,
  // and the parser only retains a bounded pending buffer.
  const fill=function*(n){
    const block=new TextEncoder().encode('0123456789'.repeat(1000)); // 10 KiB
    let sent=0;
    while(sent<n){
      const take=Math.min(block.length,n-sent);
      yield block.subarray(0,take);
      sent+=take;
    }
  };
  parser.feed('<root>');
  for(let i=0;i<items;i++){
    parser.feed('<item>');
    for(const chunk of fill(totalSize/items))parser.feed(chunk);
    parser.feed('</item>');
  }
  parser.feed('</root>');
  parser.end();
  if(count!==items)throw new Error(`expected ${items} results, got ${count}`);
};

if(typeof globalThis.gc!=='function'){
  console.error('Run with --expose-gc: node --expose-gc test/memory/stream.mjs');
  process.exit(2);
}

globalThis.gc();
run(10*MiB); // warm up allocators
globalThis.gc();
const before=process.memoryUsage().heapUsed;
const t=Date.now();
run(120*MiB);
const elapsed=Date.now()-t;
globalThis.gc();
const after=process.memoryUsage().heapUsed;
const delta=(after-before)/MiB;

console.log(`streamed 120 MiB in ${elapsed} ms; retained heap delta ${delta.toFixed(2)} MiB`);
// A non-streaming implementation would retain ~120 MiB; require a small bound.
if(delta>25){
  console.error(`FAIL: heap grew ${delta.toFixed(2)} MiB while streaming a 120 MiB document`);
  process.exit(1);
}
console.log('PASS: retained memory is bounded independently of document size');
