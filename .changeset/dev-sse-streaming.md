---
"@pracht/vite-plugin": patch
---

Stream `text/event-stream` responses in the dev server instead of buffering
them. The dev SSR middleware read every response body with `response.text()`
before writing it out, which never returns for a Server-Sent Events response —
an SSE endpoint that worked on every production adapter hung forever under
`pracht dev`. Such responses are now piped through as they are produced, and
a client disconnect destroys the pipe so `createEventStream()` cleanup
(keep-alive timers, producer loops) runs in dev exactly as in production.
