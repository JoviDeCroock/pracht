# Void Example

This example builds a Pracht app for Void deploys.

It covers two binding paths:

- `context.env.KV` in a Pracht loader
- `void/kv` in a Pracht API route, enabled by the Void adapter's runtime env wrapper

## Commands

```sh
pnpm pracht build
void deploy --skip-build
```

`void deploy --skip-build` packages the existing `dist/client/` assets and
`dist/server/server.js` Worker output from Pracht.
