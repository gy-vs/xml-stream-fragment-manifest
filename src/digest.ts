import{createHash}from'node:crypto';
import{
  canonicalize,
  FragmentCanonicalizer,
  ByteCountSink,
  type CanonicalizeOptions,
  type CanonicalSink,
  type FragmentMeta,
}from'./c14n.js';
import{XMLStreamParser}from'./parser.js';

/** Incremental digest sink: write canonical chunks as they are produced, then call digest() once. */
export class HashSink implements CanonicalSink{
  #hash:ReturnType<typeof createHash>;
  constructor(readonly algorithm='sha256'){this.#hash=createHash(algorithm)}
  write(chunk:string):void{this.#hash.update(chunk,'utf8')}
  digest(encoding:'hex'|'base64'='hex'):string{return this.#hash.digest(encoding)}
}

export const digestSubtree=(input:string|Iterable<string|Uint8Array>,options:CanonicalizeOptions,algorithm='sha256'):string=>{
  const sink=new HashSink(algorithm);
  canonicalize(input,options,sink);
  return sink.digest();
};

export interface DigestFragmentResult extends FragmentMeta{
  /** Length of this fragment's independent canonical form, in UTF-8 bytes. */
  bytes:number;
  digest:string;
}

/** Per-fragment sink that feeds both a hash context and a byte counter. */
class DigestFragmentSink implements CanonicalSink{
  readonly hash:HashSink;
  readonly count=new ByteCountSink();
  constructor(algorithm:string){this.hash=new HashSink(algorithm)}
  write(chunk:string):void{this.hash.write(chunk);this.count.write(chunk)}
}

/**
 * One-pass, per-subtree streaming digest. Each subtree matched by
 * `options.select` is canonicalized independently (a nested match yields both
 * its ancestor's result and its own) and digested in its own hash context.
 * Results are returned in document start order; an empty array means no hit.
 *
 * Invalid XML or invalid namespaces throw and no result list is produced, so
 * callers never observe a seemingly-complete partial inventory.
 */
export const digestFragments=(
  input:string|Iterable<string|Uint8Array>,
  options:CanonicalizeOptions,
  algorithm='sha256',
  encoding:'hex'|'base64'='hex',
):DigestFragmentResult[]=>{
  const results:DigestFragmentResult[]=[];
  const canonicalizer=new FragmentCanonicalizer<DigestFragmentSink>(options,{
    open:()=>new DigestFragmentSink(algorithm),
    close:(meta,sink)=>{
      results.push({...meta,bytes:sink.count.bytes,digest:sink.hash.digest(encoding)});
    },
  });
  const parser=new XMLStreamParser(e=>canonicalizer.handle(e));
  if(typeof input==='string')parser.feed(input);
  else for(const chunk of input)parser.feed(chunk);
  parser.end();
  // Nested matches close before their ancestors; report in document start order.
  return results.sort((a,b)=>a.index-b.index);
};
