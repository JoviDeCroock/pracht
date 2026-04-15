# Showcase: SaaS with per-route rendering

A fictional project management tool ("Launchpad") that demonstrates why per-route render modes matter in a real product.

Deployed at https://showcase-ten-eosin.vercel.app

## The story

| Route | Mode | Why |
|---|---|---|
| `/` | **SSG** | Marketing page. Pre-built at deploy, served from CDN, zero server cost. |
| `/blog/:slug` | **SSG** | Blog posts with `getStaticPaths`. Static content, great SEO. |
| `/pricing` | **ISG** | Revalidates every hour. Fast like static, fresh when plans change. |
| `/app` | **SSR** | Dashboard with per-request data. Personalized, always current. |
| `/app/projects/:id` | **SSR** | Project detail. Needs request context for auth + live data. |
| `/app/settings` | **SPA** | Client-only interactive UI. Shell paints instantly, no SEO needed. |

All six routes live in one `routes.ts` manifest, one build output, one deployment.

## Run it

```bash
pnpm pracht dev          # start dev server
pnpm pracht build        # production build → .vercel/output/
npx vercel deploy --prebuilt  # deploy to Vercel
```

## Key files

- `src/routes.ts` — The manifest. This is the file that tells the whole story.
- `src/shells/marketing.tsx` — Public layout with nav + footer
- `src/shells/app.tsx` — Authenticated layout with sidebar + loading state
- `src/middleware/auth.ts` — Session cookie check, redirects unauthenticated users
