# Performance — Bundle Analysis & Budgets

Pracht's core promise is shipping less JavaScript. Two built-in tools keep that
promise honest as an app grows: `pracht build --analyze` (visibility) and
per-route client-JS budgets (enforcement).

## `pracht build --analyze`

After a successful production build, `--analyze` prints a per-route report of
the client JavaScript each route actually loads:

```bash
pracht build --analyze
```

```
Route / chunk                        Gzip     Raw
/dashboard (ssr)
  /assets/dashboard-BCIbC3P5.js      744b   1.3kb
  /assets/app-CyBulJul.js            257b    447b
  total (incl. shared)             13.1kb  32.0kb
/ (ssg)
  /assets/public-CK2L2x0w.js         242b    385b
  /assets/home-DYMkGJUW.js           195b    247b
  total (incl. shared)             12.5kb  30.9kb
shared entry (all routes)
  /assets/vendor-Ccfg_lMj.js        5.8kb  14.2kb
  /assets/client-UTS10mkg.js        3.8kb  10.0kb
  total                            12.1kb  30.3kb
```

- Each route lists its **route-specific chunks**: the route module, its shell,
  and their transitive static imports, resolved from the Vite client manifest —
  the same chunks the server injects for that page.
- The **total row** includes the shared entry chunks, because that is what a
  visitor downloads on a cold load of that route.
- **Shared entry chunks** (the client runtime and the `vendor` Preact chunk)
  are broken out separately — every route pays for them once.
- Sizes are raw bytes and gzip (via `node:zlib` at the default level). Routes
  are sorted by total gzip size, descending. Colors respect `NO_COLOR`.

### JSON output

For agents and tooling, `--json` emits the same data as machine-readable JSON
(and silences the human-oriented build logs on stdout):

```bash
pracht build --json
```

```jsonc
{
  "shared": { "chunks": [...], "bytes": 30994, "gzipBytes": 12382 },
  "routes": [
    {
      "id": "dashboard",
      "path": "/dashboard",
      "render": "ssr",
      "chunks": [{ "url": "/assets/dashboard-....js", "bytes": 1329, "gzipBytes": 744 }],
      "routeBytes": 1776,
      "routeGzipBytes": 1001,
      "totalBytes": 32770,
      "totalGzipBytes": 13383
    }
  ],
  "budgets": { "results": [...], "unmatched": [], "ok": true } // when budgets are configured
}
```

## Per-route client JS budgets

Declare gzip ceilings for total client JS per route in the plugin config:

```ts
// vite.config.ts
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [
    pracht({
      budgets: {
        "*": "120kb", // default budget applied to every route
        "/dashboard": "200kb", // explicit routes override the default
      },
    }),
  ],
});
```

- Keys are route paths as written in the manifest (e.g. `/products/:productId`)
  or `"*"` as the default for all routes.
- Values are byte counts (`200000`) or size strings (`"120kb"`, `"1mb"`);
  units are 1024-based.
- The budget applies to a route's **total gzip client JS**: route chunks +
  shell chunks + shared entry chunks.

When budgets are configured, every `pracht build` evaluates them and prints a
pass/fail line per route:

```
Budgets (gzip client JS)
FAIL  /dashboard            213.1kb > 200.0kb
PASS  /                      12.5kb <= 120.0kb (*)
```

An exceeded budget makes `pracht build` exit non-zero. To keep the build output
while investigating, pass `--no-budget-fail` — the failure downgrades to a
warning.

### `pracht verify` integration

Builds with budgets write `dist/server/budget-report.json`. When that file is
present, `pracht verify` (and `pracht doctor`) surface the last build's budget
results as checks, so CI catches regressions even when it runs `verify`
separately from the build. The report reflects the most recent build — rerun
`pracht build` after changing routes or budgets.

## Reducing a route's payload

When a route blows its budget, the usual levers, in order of impact:

1. **Move heavy work server-side** — loaders run on the server; data-crunching
   dependencies never need to ship to the client.
2. **Lazy-load below-the-fold or interaction-gated code** with `lazy()` from
   `preact-suspense`, or a dynamic `import()` inside an event handler.
3. **Check the shell** — shell chunks are shared by every route using that
   shell; a heavy dependency imported in a shell taxes every page.
4. **Audit the vendor chunk** — see the `audit-bundles` skill for a guided
   deep-dive into fan-in, heavy dependencies, and prefetch tuning.
