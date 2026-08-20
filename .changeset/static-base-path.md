---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/adapter-static": minor
"@pracht/cli": minor
---

Support Vite `base` — deploying under a sub-path instead of an origin root.

`base: "/my-project/"` now produces a working deploy for a GitHub Pages *project* site, an S3 key prefix, or a reverse-proxy mount. Previously a static export rejected any non-`/` base at build time, because prerendered asset and route-state URLs were root-relative.

The base is where the deploy is *served*, not part of the output tree: `dist/client/` still contains `about/index.html`. What changes is every URL the framework emits — `<script src>`, CSS and modulepreload links, `/_pracht/state/…` fetches and preloads, `llms.txt` links, and hrefs built by `<Link route>`, `href()`, `useNavigate()`, and `prefetch()`. Route matching strips the base on both sides (the client router and `handlePrachtRequest`), so manifest route paths stay base-free, while `useLocation()` reports the URL as the visitor sees it. `pracht preview` serves the export under the same base, redirecting the bare `/my-project` and answering anything outside it with a 404.

Two deliberate boundaries:

- Hand-written root-absolute links are not rewritten. `<a href="/about">` means the origin root in HTML, matching Next's `basePath` and SvelteKit's `base`; use `<Link route="about">` or `href("about")` for internal navigation. A same-origin link outside the base is handed to the browser instead of matched as a route.
- A cross-origin base (`https://cdn.example.com/`, or protocol-relative `//cdn…`) stays a static-export build error. It relocates only assets while documents and the route-state tree remain at the origin root, and a static export serves all three from one deploy root.

With the default base of `/`, `withBase()` and `stripBase()` are the identity and output is byte-for-byte unchanged.
