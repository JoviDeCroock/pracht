---
"@pracht/adapter-node": patch
---

Stop a client disconnect from killing the production server. `createNodeRequestHandler` streamed static files, prerendered HTML, and framework responses with `await pipeline(...)` inside a handler passed straight to `http.createServer()`, which never awaits it — so a browser aborting mid-response produced an unhandled `ERR_STREAM_PREMATURE_CLOSE` rejection and, on Node >= 15, terminated the process. Reproducible with a single `curl --max-time 0.001` against any hashed asset.

The adapter now owns the plumbing instead of delegating to `stream.pipeline()`, because pipeline destroys every stream it was given on any failure — including calling `destroy(err)` on the source when the destination dies. Afterwards `req.aborted`, `req.destroyed`, `res.destroyed`, and "the source emitted an error" are all true whether the client hung up or an upstream `fetch()` body blew up, so there is nothing left to classify on. The error code cannot stand in either: undici reports a proxied backend's TCP reset as `TypeError: terminated` with `cause.code === "ECONNRESET"`, so keying on the code would file a backend outage as a client disconnect and lose it.

With the two sides kept distinct: a client disconnect completes the request quietly, a source failure rejects and `res` is left intact so the handler can still answer `500` when nothing has been written, and a response-side error is classified rather than assumed. A client that hung up *before* the pipe started — during the loader, the render, the `stat()` — is detected up front, so the promise settles and the body is cancelled instead of holding an undici connection or a file descriptor per aborted request. The source keeps its error listener for good, because `pipe()` never attaches one and a source whose teardown fails asynchronously would otherwise take the process down with an unhandled `'error'`.

The handler as a whole absorbs any remaining failure — logging, answering `500`, or destroying the socket when a partial response is already on the wire.
