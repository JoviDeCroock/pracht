---
"@pracht/adapter-vercel": patch
"@pracht/cli": patch
---

Fix `vercel deploy --prebuilt` failing with `Unexpected function type "EdgeFunction"` for ISG routes.

Vercel only supports ISR on Serverless Functions, but the build paired each
`<route>.prerender-config.json` with the edge function, so any app with an ISG
route produced an output Vercel refused to deploy. ISG routes are now emitted as
Node Serverless Functions while the main handler stays on the edge; both load
the same Web-API-only server bundle. Generated Vercel entries export a
`nodeListener` (`createVercelNodeListener(handle)`) for those functions to use,
and a custom server entry that omits it now fails the build with a descriptive
error instead of at request time.
