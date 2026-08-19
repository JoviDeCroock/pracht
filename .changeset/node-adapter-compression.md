---
"@pracht/adapter-node": minor
---

Add response compression to the Node adapter. Responses are negotiated against
`Accept-Encoding` (highest q-value wins per RFC 9110, including an explicitly
higher `identity` preference, with brotli preferred on ties) and compressed
with `node:zlib`: dynamic documents, route-state JSON, and other compressible
text types stream through a zlib transform that flushes per written chunk (so
SSE and other incrementally produced bodies are delivered as they are
written), while static assets and (re)generated ISG documents are compressed
once per file version at higher quality and served from an in-memory LRU.
Concurrent first requests share one in-flight compression, while
byte/concurrency limits send excess cold paths through streaming compression.
Successful ISG writes are published as an atomic file replacement and
explicitly invalidate their prior local compressed cache generation. Public
validators derive only from the replacement's durable file identity so sibling
handlers agree on the ETag, including for same-size rewrites on
coarse-timestamp filesystems and after a handler restart. Static response reads
stay bound to the same open file version that supplied their size and validator,
so a concurrent replacement cannot bypass the cold-work budget or mix new
bytes with old metadata. Date-only validation is conservatively bypassed for
mutable compressed ISG snapshots.
Compressible responses always carry
`Vary: Accept-Encoding` (merged with existing `Vary` members), including on
application-generated `304` responses, encoded
variants get their own collision-resistant weak ETag so conditional
revalidation never crosses encodings or aliases a later application-provided
identity validator (including when applications provide strong identity
validators or use the adapter's reserved ETag namespace),
dynamic `If-None-Match` and `If-Modified-Since` validation runs after
representation selection (with ETag precedence) and supports commas inside
quoted opaque tags, static `.wasm` files are served as compressible
`application/wasm`, `HEAD` uses the same negotiated representation metadata
as `GET` (including buffered compressed lengths), and already-encoded
responses, `Cache-Control: no-transform`, Range/204/304 responses, binary
media, integrity-protected responses, and bodies under 1 KiB (when the size is
known) are left untouched. Identity `Content-Length` values are removed before
streaming an encoded static response, Range requests retain their conditional
headers, cancellation failures cannot replace a valid conditional `304` with
a `500`, and a body failure before the first byte clears staged compression
metadata before the adapter returns its unencoded 500 fallback.
Disable with `nodeAdapter({ compression: false })` — recommended when a reverse
proxy or CDN in front of the server already compresses responses.
