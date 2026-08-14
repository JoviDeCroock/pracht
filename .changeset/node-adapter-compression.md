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
once per file version at higher quality — concurrent first requests share one
in-flight compression — and served from an in-memory LRU. Compressible
responses always carry
`Vary: Accept-Encoding` (merged with existing `Vary` members), encoded
variants get their own weak ETag so conditional revalidation never crosses
encodings, dynamic variant ETags revalidate through the adapter, `HEAD` uses
the same negotiated representation metadata as `GET`, and already-encoded
responses, `Cache-Control: no-transform`, Range/204/304 responses, binary
media, and bodies under 1 KiB (when the size is known) are left untouched.
Disable with `nodeAdapter({ compression: false })` — recommended when a reverse
proxy or CDN in front of the server already compresses responses.
