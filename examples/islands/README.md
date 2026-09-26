# Pracht Islands Example

Demonstrates the islands architecture (partial hydration):

- `/` — SSG page with a `Counter` island (default `load` strategy) next to a
  server component whose `onClick` never hydrates.
- `/lazy` — SSG page with a below-the-fold island using `client="visible"`:
  its chunk is fetched and hydrated only when it scrolls into view.
- `/static` — `hydration: "none"`, ships zero JavaScript.
- `/ssr` — SSR route with an `client="idle"` island, proving islands work at
  request time, not just at build time.
- `/full` — a regular full-hydration route living in the same app.
- `/regions`, `/regions/ssr`, `/regions/islands`, `/regions/full` — a
  request-time region (`src/regions/Visitor.tsx`) that greets whoever the
  `visitor` cookie names. The prerendered pages are identical for every
  visitor and fill the region after load; the SSR page renders it inline.
  Set `document.cookie = "visitor=Ada"` and reload to see it change.

Islands live in `src/islands/` and are auto-discovered by the vite plugin.
Routes opt in with `hydration: "islands"` in `src/routes.ts`. Regions live in
`src/regions/` (see `docs/REGIONS.md`).

```bash
pnpm --filter @pracht/example-islands exec pracht dev
pnpm --filter @pracht/example-islands exec pracht build
```

See `docs/ISLANDS.md` for the full documentation.
