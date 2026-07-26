---
"@pracht/core": minor
"@pracht/adapter-cloudflare": minor
---

Serve WebSocket upgrades from API routes.

Pracht owns the worker's `fetch`, and every API response used to be rebuilt via
`new Response(response.body, { status, headers })` to stamp the default security
headers. A `101 Switching Protocols` response cannot survive that: the Response
constructor rejects any status below 200, and Cloudflare's `webSocket` handle is
not part of `ResponseInit`, so it would be dropped even where the status was
tolerated. The thrown `RangeError` was caught by the API error path, so a
WebSocket handler returned an opaque 500.

Protocol-switch responses are now passed through the response pipeline
untouched — same object, socket intact, no header or cache post-processing (a
handshake has no body for those policies to protect). The new
`isProtocolSwitchResponse()` export from `@pracht/core/server` is what adapters
use to detect them.

On Cloudflare, an upgrade request also now skips the ISG and static-asset
lookups, so a handshake no longer costs a wasted subrequest against the assets
binding on every connection. Return the handshake from an API route — typically
by forwarding the request to a Durable Object, which owns the socket for as long
as it stays open. `examples/cloudflare` ships a working `ChatRoom` object and
`src/api/ws.ts` route.

**Security change:** `api.requireSameOrigin` (on by default) now also applies to
upgrade requests, which are `GET` and were therefore previously exempt from the
method-based check. Browsers do not apply CORS to WebSocket, so without this any
page on the web could open a cookie-authenticated socket to your app
(cross-site WebSocket hijacking). This cannot break existing apps, since no
upgrade could reach a handler before this release.

The Node and Vercel adapters still cannot serve upgrades. On Node this is
structural rather than a gap in the adapter: `http.Server` routes upgrade
requests to its `upgrade` event, not to the request handler, so they never reach
pracht. `docs/ADAPTERS.md` documents attaching a `ws` server to the same HTTP
server alongside pracht's exported `handler`.
