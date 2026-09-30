import{createHash}from'node:crypto';
import{canonicalize,type CanonicalizeOptions,type CanonicalSink}from'./c14n.js';

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
