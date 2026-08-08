# Import Boundaries

Pracht keeps server and browser module graphs explicit. The Vite plugin rejects
a first-party module when its filename or marker conflicts with the graph that
is currently being built.

## Filename conventions

Use `.server.*` for modules that may only enter server graphs and `.client.*`
for modules that may only enter browser graphs:

```ts
// src/data/session.server.ts
export async function readSession() {}

// src/editor/shortcuts.client.ts
export function bindShortcuts() {}
```

A component importing `session.server.ts` fails the client build. A loader,
middleware, API route, or other server entry importing `shortcuts.client.ts`
fails the server build. The diagnostic names the restricted module, importer,
and target graph.

The convention applies to first-party files under the Vite project root.
Dependencies under `node_modules` retain their own environment conventions.

## Explicit markers

When a neutral filename is preferable, add a side-effect marker at the top of
the module:

```ts
import "@pracht/core/server-only";
// or
import "@pracht/core/client-only";
```

The marker subpaths are type-resolvable no-op modules; the Pracht Vite plugin
turns a cross-graph import into a build error.

## Route modules

Inline `loader`, `head`, `headers`, `getStaticPaths`, and `markdown` exports may
import server-only modules. Pracht removes those exports and imports before it
resolves the browser dependency graph. Shared component code must not reference
the server-only import.

Dependency-optimizer scans are ignored for the same reason: they inspect the
unstripped source. The real client and server transforms remain enforced.

## Configuration

Boundaries are enabled by default. A migration can temporarily disable them:

```ts
pracht({ importBoundaries: false });
```

Treat this as a short-lived compatibility escape hatch. It removes structural
protection against server code entering browser bundles and browser-only code
executing during SSR.
