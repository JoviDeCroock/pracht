---
"@pracht/vite-plugin": patch
---

Strip server-only exports from route and shell files in the client environment
even when they are imported without the `?pracht-client` query.

Previously, the transform ran only for ids that carried the query added by the
`import.meta.glob` registry. A client module that imported a route file
directly (e.g. `import Foo from "../routes/foo.tsx"`) bypassed the registry
and exposed `loader`, `head`, `headers`, and `getStaticPaths` in the browser
bundle. The transform now also triggers for any `.ts/.tsx/.js/.jsx/.md/.mdx`
file inside the configured `routesDir`, `shellsDir`, or `pagesDir` whenever
Vite is processing the file for a non-SSR environment.
