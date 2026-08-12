# Pracht static-export example

A small manifest app built with `@pracht/adapter-static`: SSG routes with loaders, a dynamic SSG route (`getStaticPaths`), SPA routes (including a dynamic one that relies on the `200.html` fallback), and a notFound page emitted as `404.html`.

```bash
pnpm build      # in this directory: node ../../packages/cli/bin/pracht.js build
pnpm exec pracht preview
```

Deploy `dist/client/` to any static host. The e2e suite (`e2e/static-build.test.ts`) builds this example and serves `dist/client` with a dumb static file server to prove client-side navigation works with zero server.
