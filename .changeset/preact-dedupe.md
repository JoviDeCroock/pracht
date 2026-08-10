---
"@pracht/vite-plugin": patch
---

Dedupe Preact so a second copy in the graph cannot break hooks.

Preact keeps hook state on module-level `options` belonging to the instance
that rendered the tree. A second copy — from package-manager hoisting, a
`link:`ed package, or a UI library that depends on Preact itself — makes every
hook-using component fail during SSR with:

```
Cannot read properties of undefined (reading '__H')
```

which names neither the component nor the cause. The plugin now sets
`resolve.dedupe` for `preact` and `preact-render-to-string`, which covers dev
SSR, the client bundle, and edge SSR builds (where `ssr.noExternal` bundles
everything). Production Node servers keep Preact external and resolve it
through Node at runtime, so a duplicate there is still a `node_modules` layout
problem rather than something Vite can collapse.

Apps that already resolve a single Preact are unaffected: two example apps
build to byte-identical output.
