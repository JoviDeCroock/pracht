---
"@pracht/cli": patch
---

Load `.env` into `process.env` for `pracht dev`.

Vite reads `.env` files but only exposes prefixed keys through
`import.meta.env`; it never writes to `process.env`. Server-side code reads
`process.env` (that is what `serverEnv` resolves to on Node and Vercel), so an
unprefixed secret in `.env` was simply invisible. Writing
`PRACHT_CONFIRMATION_SECRET` into the file the scaffold's `.gitignore` already
anticipates had no effect, and a destructive capability failed closed with
`confirmation_unavailable` while the value sat right there.

Wrangler already does this for Cloudflare apps ("Using secrets defined in
.env"), so the identical project behaved differently per adapter.

Dev only. Real environment variables win over the file, `.env.local` beats
`.env.development` beats `.env`, and `NODE_ENV` is never taken from the file
(Vite refuses `NODE_ENV=production` there on purpose, and the dev server is
always mode `development` whatever the shell says).

`pracht build`, the production server, and `pracht verify` / `pracht doctor`
still read only the real environment: verification reports on what a deployment
will have, so a destructive capability whose secret lives only in `.env` stays
an error — its message now says where the value has to live instead.
