---
"@pracht/core": minor
---

Add per-route opt-in `speculation` config that emits a browser-native
`<script type="speculationrules">` block from the SSR/SSG renderer. Routes can
declare `speculation: "prefetch"` (default eagerness `moderate`) to let the
browser fetch the page HTML on intent, or `speculation: "prerender"` (default
eagerness `conservative`) to fully render the document in the background.
Routes flagged for `prerender` are skipped by the SPA click interceptor so the
browser can activate the prerendered document on click. Group meta also
accepts `speculation` and propagates to descendant routes. Accepts an object
form `{ mode, eagerness }` for finer control.
