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
Successful ISG writes explicitly invalidate their prior compressed cache
generation, including same-size rewrites on coarse-timestamp filesystems.
Compressible responses always carry
`Vary: Accept-Encoding` (merged with existing `Vary` members), encoded
variants get their own weak ETag so conditional revalidation never crosses
encodings (including when applications provide strong identity validators),
dynamic `If-None-Match` and `If-Modified-Since` validation runs after
representation selection (with ETag precedence) and supports commas inside
quoted opaque tags, static `.wasm` files are served as compressible
`application/wasm`, `HEAD` uses
the same negotiated representation metadata as `GET`, and already-encoded
responses, `Cache-Control: no-transform`, Range/204/304 responses, binary
media, integrity-protected responses, and bodies under 1 KiB (when the size is
known) are left untouched. Identity `Content-Length` values are removed before
streaming an encoded static response, and a body failure before the first byte
clears staged compression metadata before the adapter returns its unencoded
500 fallback.
Disable with `nodeAdapter({ compression: false })` — recommended when a reverse
proxy or CDN in front of the server already compresses responses.
