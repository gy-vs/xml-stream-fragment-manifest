# XML stream tools

Run `npm ci`, `npm test`, and `npm run build`.

## Per-fragment canonicalization and digests

`canonicalForm` / `digestSubtree` take a path selector and concatenate **all**
matched subtrees into one canonical string or digest. They cannot tell you
*which* fragment changed between two archives. For that, use the per-fragment
API: each matched subtree is canonicalized independently in a single streaming
pass.

```ts
import {digestFragments} from './dist/index.js';

const results = digestFragments(xml, {select: '//item'});
// [
//   {index: 0, path: '/root[1]/item[1]', steps: [...], bytes: 14, digest: '…'},
//   {index: 1, path: '/root[1]/item[2]/item[1]', …},   // nested hit
//   {index: 2, path: '/root[1]/item[2]', …},
// ]
```

- **One result per matched element**, ordered by the element start position.
  `index` is that 0-based start order; `path` (`/a[1]/b[2]`) and `steps` give
  the element path with 1-based positions among same-named siblings.
- **Nested matches appear twice in the data, never mixed**: the inner subtree
  is rendered inside the outer result *and* produced as its own result, each
  with an independent byte count (`bytes`, UTF-8) and digest.
- **Standalone namespace semantics**: every result is canonicalized in its own
  namespace context, so bindings inherited from ancestors are re-rendered
  exactly as if the element were the sole target of `canonicalForm`.
- `withComments`, text/attribute escaping, attribute ordering and UTF-8 chunk
  handling apply per fragment; chunk boundaries never change a path, byte
  count or digest.
- No match ⇒ `[]`. Malformed XML or invalid namespaces throw before a result
  list is produced — you never get a seemingly-complete partial inventory.
- `canonicalFragments(xml, options)` is the text equivalent; each result's
  `sink.text` is that fragment's canonical form.

Compare inventories between two archives by `path`, or cross-check any single
result against the single-subtree API:

```ts
const r = digestFragments(xml, {select: '//item'}).find(r => r.path === p)!;
r.digest === digestSubtree(xml, {select: '/root/item/item'}); // same bytes
```

### Streaming handler (read-once sources, bounded memory)

`FragmentCanonicalizer` fits the same public chain as `Canonicalizer`:

```ts
const fc = new FragmentCanonicalizer<HashSink>({select: '//item'}, {
  open(meta) { return new HashSink(); },      // called at element start
  close(meta, sink) { list.push({...meta, digest: sink.digest()}); },
});
const parser = new XMLStreamParser(e => fc.handle(e));
for await (const chunk of readOnceStream) parser.feed(chunk); // string or Uint8Array
parser.end();
```

`close` fires in end (LIFO) order; the convenience helpers above sort by
`index` into start order. Only open elements and the parser's bounded pending
buffer are retained — memory does not grow with document size
(`npm run test:memory` streams 120 MiB with a fixed heap footprint).
