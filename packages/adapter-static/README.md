# @pracht/adapter-static

Static output adapter for pracht. Builds a deployment with no server runtime:
prerendered SSG documents, client-rendered SPA documents, islands, a `404.html`,
and the build-time route-state snapshots the client router reads instead of
calling a server.

Deploy the result to Netlify, Vercel, Cloudflare Pages, GitHub Pages, S3, or any
other static host.

## Install

```bash
npm install @pracht/adapter-static
```

## Usage

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { staticAdapter } from "@pracht/adapter-static";

export default defineConfig({
  plugins: [pracht({ adapter: staticAdapter({ host: "netlify" }) })],
});
```

`host` selects the host configuration written next to `dist/client`:

| `host`      | Output                                                                        |
| ----------- | ----------------------------------------------------------------------------- |
| `netlify`   | `dist/client/_headers` and `dist/client/_redirects` (also read by Cloudflare Pages) |
| `vercel`    | Functionless Build Output API v3 in `.vercel/output` — `vercel deploy --prebuilt` |
| `generic`   | `dist/client` only; the build prints the rules to configure by hand           |

## What the app may contain

Every route has to be renderable ahead of time. `pracht build` fails with the
offending routes listed when it is not:

| Feature                          | Static build                                            |
| -------------------------------- | ------------------------------------------------------- |
| `render: "ssg"`                  | Prerendered, with a route-state snapshot per path       |
| `render: "spa"`                  | Shell + `Loading()` document, rendered in the browser   |
| `hydration: "islands"` / `"none"` | Supported on any prerendered route                      |
| `render: "ssr"` / `"isg"`        | Build error — no runtime to render or revalidate        |
| API routes (`src/api`)           | Build error — nothing serves them                       |
| HTTP capabilities / `agents`     | Build error — their policy and endpoints need a runtime |
| Middleware                       | Runs at build time only                                 |
| `defineApp({ notFound })`        | Written to `404.html`                                   |

Full-hydration SSG navigation reads build-time loader snapshots from
`/_pracht/state/<path>/index.json`. Rebuild and redeploy to refresh them.

## Preview

`pracht preview` serves `dist/client` with the emitted rewrite and header rules
applied, so clean URLs, SPA fallbacks, and `404.html` behave the way the host
will serve them.

Use the HTTP preview rather than opening generated HTML with `file://`. Pracht
emits root-relative hashed stylesheet URLs such as `/assets/site-abc.css`; a
file URL resolves those against the filesystem root and makes valid output look
unstyled.
