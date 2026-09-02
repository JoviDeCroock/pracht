---
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-netlify": patch
"@pracht/adapter-node": patch
"@pracht/adapter-static": patch
"@pracht/adapter-vercel": patch
"@pracht/capabilities": patch
"@pracht/cli": patch
"@pracht/content": patch
"@pracht/core": patch
"@pracht/i18n": patch
"@pracht/image": patch
"@pracht/markdown": patch
"@pracht/openapi": patch
"@pracht/preact-ssr-precompile": patch
"@pracht/test": patch
"@pracht/vite-plugin": patch
"create-pracht": patch
---

Declare `engines.node: ">=22.18"` so installing on an unsupported Node version warns up front instead of failing later in a build.
