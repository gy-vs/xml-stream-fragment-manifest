# XML stream tools

Run `npm ci`, `npm test`, and `npm run build`.

## Per-fragment streaming

`canonicalForm` / `digestSubtree` concatenate **all** matched subtrees into one
output. `digestFragments` instead canonicalizes **each** matched subtree
independently in a single pass over the input:

```ts
import {digestFragments} from './dist/index.js';

const results = digestFragments(archive, {select: '//record'});
// [] when nothing matches; throws on malformed XML / invalid namespaces
for (const r of results) {
  r.index;      // 0-based, order of the elements' start tags
  r.path;       // [{name, uri, local, position}, ...] from the document root
  r.pathString; // e.g. "/root/sec/record[2]"
  r.bytes;      // UTF-8 byte length of this fragment's canonical form
  r.digest;     // hex digest of exactly those bytes
}
```

Inner matches get their own result while also remaining part of the enclosing
fragment's bytes:

```ts
digestFragments('<r><a>x<a>y</a></a></r>', {select: '//a'});
// path "/r/a"   -> canonical "<a>x<a>y</a></a>"
// path "/r/a/a" -> canonical "<a>y</a>"
```

Each fragment is canonicalized with a fresh exclusive-c14n context, so an
inner result is byte-identical to running `canonicalForm`/`digestSubtree` on
that subtree alone (namespace bindings inherited from ancestors are
re-declared as needed). `withComments`, text/attribute escaping, attribute
sorting, prefix bindings and UTF-8 chunking all apply per fragment, and moving
chunk boundaries never changes any path, byte count or digest.

Custom streaming processing plugs into the same public chain:

```ts
import {FragmentCanonicalizer, XMLStreamParser} from './dist/index.js';

const canonicalizer = new FragmentCanonicalizer({select: '//record'}, {
  open(header) {            // called at each matched start tag
    return {
      write(chunk) {/* canonical bytes of this fragment only */},
      close(header) {/* finalize, e.g. hash.digest() */},
    };
  },
});
const parser = new XMLStreamParser(e => canonicalizer.handle(e));
// feed strings or UTF-8 chunks from a single-use source, then parser.end()
```

`FragmentDigestHandler` (used by `digestFragments`) retains only digest state
plus per-open-element bookkeeping, so memory is bounded by document depth and
the number of open matches, not by document size. Use `FragmentTextHandler` /
`canonicalizeFragments` when you need each fragment's canonical text itself.
