---
"@pracht/core": patch
---

Parallelize independent work in the server request pipeline. Middleware module
imports now resolve concurrently (execution order is still preserved), and the
route module, shell module, and separate-file loader module imports are kicked
off alongside the middleware chain instead of waiting for it. The shell/route
`head` and `headers` exports also run concurrently inside each merge step.

No API changes. Observable effect: lower TTFB on cold starts where modules
ship as separate chunks, and lower end-to-end request latency whenever shell
or head/headers work was previously waiting for the loader.
