# @pracht/adapter-vercel

Vercel adapter for pracht. Emits Vercel Build Output API v3 output with an Edge Function entry for SSR/API routes and Node Serverless Functions for ISG routes.

## Install

```bash
npm install @pracht/adapter-vercel
```

## Usage

Select the Vercel adapter when scaffolding with `create-pracht`, or add it to an existing project:

```bash
npm create pracht@latest my-app  # choose Vercel
```

Deploy with:

```bash
pracht build && vercel deploy --prebuilt
```

## Features

- Build Output API v3 integration
- Edge Function runtime support
- Native ISR through Node Serverless prerender functions
- Static SSG rewrites with route-state bypasses for client navigation

## Context factory

Generated entries can import an app-level context factory:

```ts
import { vercelAdapter } from "@pracht/adapter-vercel";

pracht({
  adapter: vercelAdapter({ createContextFrom: "/src/server/context.ts" }),
});
```

`/src/server/context.ts` should export `createContext({ request, context })`.
Edge invocations receive Vercel's execution context. Node ISG invocations
receive a compatibility context with `waitUntil()`; other Edge-only fields are
unavailable.

`vercelAdapter({ regions: "all" })` keeps the Edge function global and leaves
Node ISG functions on the project's default Serverless region. Configure one or
more concrete region identifiers to place both runtimes explicitly.
