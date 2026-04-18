---
name: audit-a11y
version: 1.0.0
description: |
  Per-route accessibility audit for a pracht app. Drives a headless browser
  through every route in the manifest, runs axe-core, and reports issues
  grouped by severity and route. Catches alt-text gaps, contrast failures,
  missing landmarks, focus-order bugs, and form-label problems.
  Use when asked to "audit a11y", "check accessibility", "axe my app",
  "WCAG compliance", or "screen reader test".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Audit A11y

Static linting cannot prove a route is accessible — many issues only appear
in the rendered DOM. This skill renders each route in a real browser and
runs axe-core against the result.

## Step 1: Boot the app

Prefer `pracht preview` (production build) — production HTML is what users
actually receive. Fall back to `pracht dev` only if the user can't build.

```bash
pracht build && pracht preview &
```

Or, if `BASE_URL` is set, target the deployed app.

## Step 2: Install runner

If Playwright is already wired (see `scaffold-e2e`), reuse it:

```bash
pnpm add -D @axe-core/playwright
```

If not, scaffold a one-off script using `playwright` directly. Prefer
Playwright over Puppeteer for consistency with existing project tooling.

## Step 3: Enumerate routes

```bash
pracht inspect routes --json
```

For dynamic-segment routes, ask the user once for example params (or skip
with a note in the report).

## Step 4: Generate the audit script

`scripts/audit-a11y.ts`:

```ts
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const ROUTES: string[] = [/* injected from pracht inspect routes */];

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const results = [];
for (const path of ROUTES) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "best-practice"])
    .analyze();
  results.push({ path, violations: axe.violations });
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
```

## Step 5: Run and aggregate

```bash
pnpm exec tsx scripts/audit-a11y.ts > a11y-report.json
```

Aggregate by:

- **Per-route summary**: violation count, worst severity.
- **Per-rule summary**: which rule fires most across the app — usually
  reveals a single component (header, footer, form) that authors every page.

## Step 6: Report

```
## Per-route summary

| Route       | Critical | Serious | Moderate | Minor |
| ----------- | -------- | ------- | -------- | ----- |
| /           | 0        | 1       | 2        | 0     |

## Per-rule summary (top offenders)

- `color-contrast` — 12 violations across 8 routes
  → Likely source: shared Button component (src/components/Button.tsx)
- `image-alt` — 5 violations across 3 routes
  → Likely source: <img> in shells/marketing.tsx

## Detail

[per-route violations with selectors and help URLs]
```

## Step 7: Targeted fixes

For the top 3 issues, propose concrete patches:

- `color-contrast` → suggest tokenized color pairs from existing CSS vars.
- `image-alt` → list every `<img>` missing `alt` and propose either a
  description or `alt=""` (decorative).
- `landmark-one-main` → confirm shells render exactly one `<main>` element.
- `label` → list inputs without associated `<label>` and propose
  `htmlFor`/`for` or wrapping pattern.

## Rules

1. Run against `pracht preview` if at all possible — minified production
   markup is what real users hit.
2. axe with WCAG 2.1 AA + best-practice tags is the default; ask before
   downgrading.
3. Aggregate by rule before per-route — the same component is usually
   responsible for most violations.
4. Do not auto-fix. Suggest, then let the user review per component.
5. For SPA routes that need interaction before content appears, ask the user
   for a setup hook (e.g., a script that logs in and lands on the dashboard).

$ARGUMENTS
