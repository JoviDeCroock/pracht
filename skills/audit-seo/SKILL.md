---
name: audit-seo
version: 1.0.0
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
returning `{ title?, lang?, meta?, link? }`. This skill audits coverage and
generates the static SEO artifacts.

## Step 1: Inventory

```bash
pracht inspect routes --json
```

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

Look for:
- `public/robots.txt` (Vite static asset).
- Any route at `/robots.txt`.
- Any API handler at `src/api/robots.ts`.

If absent, recommend creating `public/robots.txt`:

```
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Sitemap: https://<domain>/sitemap.xml
```

If present, validate:
- A `Sitemap:` line referencing an existing endpoint.
- No accidental `Disallow: /` (full-site block).
- Path patterns match real routes (cross-reference with the manifest).

## Step 5: `sitemap.xml`

Generate (or recommend generating) a sitemap from the route manifest:

- Include every route with `render: "ssg"` or `"isg"` and `prefetch !=
  "none"`.
- Skip dynamic-segment routes unless `getStaticPaths` resolved them at build
  time — pull resolved paths from `dist/client/<route>.html` filenames.
- Skip routes under auth middleware (private).
- Default `<changefreq>` from the route's revalidate policy: `timeRevalidate`
  → `weekly` if `> 86400s`, `daily` if `> 3600s`, `hourly` otherwise.

Offer two output forms:

1. Static `public/sitemap.xml` regenerated at build time via a small script.
2. A pracht API route at `src/api/sitemap.ts` that emits XML on each request
   from the inspected manifest.

## Step 6: Structured data (optional)

If the user asks, scaffold JSON-LD for common types via `head()` `meta` /
`link` tags or a custom shell-level script. This is opt-in — do not push it
on every audit.

## Step 7: Report

| Route | Title | Description | OG image | Canonical | Verdict |
| ----- | ----- | ----------- | -------- | --------- | ------- |

Verdicts: `complete`, `partial`, `missing`. Group by verdict.

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
