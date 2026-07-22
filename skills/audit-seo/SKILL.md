---
name: audit-seo
version: 1.1.0
description: |
  Per-route SEO audit for a pracht app: `head()` coverage, title/description
  presence, Open Graph and Twitter card completeness, canonical URLs, robots
  rules, and a generated `sitemap.xml` derived from the route manifest.
  Use when asked to "audit SEO", "check meta tags", "generate a sitemap",
  "are my OG cards set", or "review robots.txt".
allowed-tools:
  - Bash
  - Read
  - Write
  - Grep
  - Glob
---

# Pracht Audit SEO

Pracht owns the document. Per-route SEO lives in the `head()` export
returning `{ title?, lang?, meta?, link?, script? }`. This skill audits
coverage and generates the static SEO artifacts.

## Step 1: Inventory

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

```bash
pracht inspect routes --json
```

Prerequisite: `pracht inspect` needs a vite config with the pracht plugin
wired up; run from the app root.

For every route file, read the `head()` export (and the shell's `head()` for
inherited values).

## Step 2: Per-route checklist

For each route, capture presence and quality:

| Field                                    | Expected                          |
| ---------------------------------------- | --------------------------------- |
| `title`                                  | 30-60 chars, unique per route     |
| `meta` `description`                     | 70-160 chars, unique per route    |
| `meta` `og:title`                        | Present (often = `title`)         |
| `meta` `og:description`                  | Present                           |
| `meta` `og:image`                        | Absolute URL, ≥ 1200×630          |
| `meta` `og:url`                          | Absolute, canonical               |
| `meta` `twitter:card`                    | `summary_large_image` for content |
| `link` `canonical`                       | Absolute URL                      |
| `script` (JSON-LD)                       | Optional; see Step 6              |
| `lang`                                   | Set on root or via shell          |

Skip SPA-only / non-indexable routes (admin, dashboard) — flag as "noindex
candidate" if they don't already declare it.

## Step 3: Cross-route checks

- **Duplicate titles** across routes — list collisions.
- **Duplicate descriptions** — same.
- **Missing canonical** on any route that has any `?query` variants.
- **Missing OG image** — most common issue; recommend a default image at
  shell level so every route inherits one.

## Step 4: `robots.txt`

`robots.txt` MUST be served at the origin root (`/robots.txt`) — crawlers
never look anywhere else. Pracht API routes are always mounted under `/api/`
(a `src/api/robots.ts` handler serves `/api/robots`, never `/robots.txt`), so
an API handler cannot provide it. The workable option is the static asset:

- `public/robots.txt` (Vite static asset, served at `/robots.txt`).

If absent, recommend creating `public/robots.txt`:

```
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Sitemap: https://<domain>/sitemap.xml
```

If present, validate:
- A `Sitemap:` line referencing an existing endpoint (see Step 5 — if the
  sitemap is an API route, this must point at `/api/sitemap`).
- No accidental `Disallow: /` (full-site block).
- Path patterns match real routes (cross-reference with the manifest).
- Flag any `src/api/robots.ts` found in the repo as `warn`: it is dead
  weight at `/api/robots` and does not serve `/robots.txt`.

## Step 5: sitemap

Generate (or recommend generating) a sitemap from the route manifest:

- Include routes by **indexability**, not prefetch strategy: public
  `render: "ssg"`/`"isg"` routes (and public SSR routes worth indexing),
  minus routes under auth middleware, minus routes declaring a
  `robots`/`noindex` meta. (`prefetch` is a client navigation hint —
  orthogonal to indexability; do not use it as a criterion.)
- Skip dynamic-segment routes unless `getStaticPaths` resolved them at build
  time — pull resolved paths from the prerender output, which is laid out as
  `dist/client/<route>/index.html` (clean URLs; e.g. `/about` →
  `dist/client/about/index.html`).
- Default `<changefreq>` from the route's revalidate policy: `timeRevalidate`
  → `weekly` if `> 86400s`, `daily` if `> 3600s`, `hourly` otherwise.

Offer two output forms:

1. Static `public/sitemap.xml` regenerated at build time via a small script
   (served at `/sitemap.xml`).
2. A pracht API route at `src/api/sitemap.ts` that emits XML on each request
   from the inspected manifest. It is served at `/api/sitemap` (API routes
   always mount under `/api/`), so the robots `Sitemap:` line must point at
   `https://<domain>/api/sitemap`.

## Step 6: Structured data (optional)

If the user asks, scaffold JSON-LD via the `head()` export's native `script`
field — `HeadMetadata` supports `script?: HeadScriptDescriptor[]`, where each
descriptor takes attributes plus `children` for the inline body:

```ts
export function head() {
  return {
    script: [
      {
        type: "application/ld+json",
        children: JSON.stringify({ "@context": "https://schema.org", ... }),
      },
    ],
  };
}
```

No shell-level custom `<script>` JSX is needed. This is opt-in — do not push
it on every audit.

## Step 7: Report

| Route | Severity | Title | Description | OG image | Canonical | Verdict |
| ----- | -------- | ----- | ----------- | -------- | --------- | ------- |

Primary severity per finding: `error` (site blocked by robots, auth-gated
route in sitemap), `warn` (missing title/description/OG image/canonical on an
indexable route), `info` (nice-to-haves like JSON-LD). Keep the
`complete`/`partial`/`missing` verdict as a secondary per-route rollup,
grouped by verdict.

## Rules

1. Use the resolved manifest — shell `head()` inheritance matters.
2. Never auto-write `sitemap.xml` to the deployed site without user
   confirmation; offer the file as a draft.
3. Recommend a default OG image at the shell level — single highest-leverage
   fix.
4. Auth-gated routes should NOT appear in sitemaps.
5. Cross-reference with `tune-render-mode` — SSG routes are the sitemap
   candidates; SSR routes need decision per case.

$ARGUMENTS
