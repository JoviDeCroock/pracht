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

Islands live in `src/islands/` and are auto-discovered by the vite plugin.
Routes opt in with `hydration: "islands"` in `src/routes.ts`.

```bash
pnpm --filter @pracht/example-islands exec pracht dev
pnpm --filter @pracht/example-islands exec pracht build
```

See `docs/ISLANDS.md` for the full documentation.
