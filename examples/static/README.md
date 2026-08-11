# Static example

A pracht app that deploys as files: no server, no functions.

```bash
pnpm --filter @pracht/example-static exec pracht build
pnpm --filter @pracht/example-static exec pracht preview
```

## What it covers

| Route            | Mode                        | What it shows                                              |
| ---------------- | --------------------------- | ---------------------------------------------------------- |
| `/`              | `ssg` + loader              | Build-time data, and a route-state snapshot for navigation |
| `/docs/:slug`    | `ssg` + `getStaticPaths()`  | One prerendered file per enumerated path                   |
| `/about`         | `ssg`, `hydration: "none"`  | Zero JavaScript, plus a `headers()` export                 |
| `/counter`       | `ssg`, `hydration: "islands"` | Static HTML with one hydrated island                     |
| `/dashboard`     | `spa`                       | Shell + `Loading()` document, rendered in the browser      |
| `/projects/:id`  | `spa`, dynamic              | One fallback document for the whole pattern                |
| anything else    | `notFound`                  | Written to `404.html`                                      |

## Hosts

`PRACHT_STATIC_HOST` selects the host configuration:

```bash
PRACHT_STATIC_HOST=netlify pracht build   # dist/client/_headers + _redirects
PRACHT_STATIC_HOST=vercel  pracht build   # .vercel/output, no functions
PRACHT_STATIC_HOST=generic pracht build   # dist/client only
```
