# Pracht Skills

Repo-local Claude Code skills. Two audiences:

- **Framework-author skills** help people working on pracht itself.
- **End-user skills** help people building applications with pracht.

Skills live one directory per skill, each with a `SKILL.md` defining
frontmatter (`name`, `version`, `description`, `allowed-tools`) and an
action-oriented body. Invoke a skill in Claude Code with `/<skill-name>`.

## Framework-author skills

| Skill              | Use when                                                     |
| ------------------ | ------------------------------------------------------------ |
| `/scaffold`        | Generate routes, shells, middleware, or API handlers.        |
| `/debug`           | Investigate route matching, loader, rendering, or HMR bugs.  |
| `/deploy`          | Configure an adapter and deploy to Node, Cloudflare, Vercel. |
| `/migrate-nextjs`  | Convert a Next.js app (App or Pages Router) to pracht.       |

## End-user skills

### Audit & review

| Skill               | Use when                                                            |
| ------------------- | ------------------------------------------------------------------- |
| `/audit-loaders`    | Check loaders for serializability, leaked secrets, browser-only APIs. |
| `/audit-shells`     | Verify shell composition: `Loading()`, `head()`, no document tags.  |
| `/audit-auth`       | Find protected routes missing auth middleware.                      |
| `/audit-csrf`       | Verify CSRF posture on forms and mutation APIs.                     |
| `/audit-headers`    | Per-route security header coverage; CSP suggestion.                 |
| `/audit-secrets`    | Detect env vars / secrets reaching the client bundle.               |
| `/audit-redirects`  | Open-redirect detection in loaders, middleware, navigation.         |
| `/audit-deps`       | npm/pnpm audit mapped to which routes use the vulnerable package.   |
| `/audit-bundles`    | Per-route client payload size and code-splitting recommendations.   |
| `/audit-seo`        | `head()` coverage, OG cards, sitemap, robots.txt.                   |
| `/audit-a11y`       | Per-route axe-core run with WCAG 2.1 AA defaults.                   |
| `/tune-render-mode` | Recommend SSG/ISG/SSR/SPA per route based on loader contents.       |
| `/pre-deploy`       | Adapter-aware pre-deployment checklist.                             |

### Testing scaffolds

| Skill              | Use when                                                                  |
| ------------------ | ------------------------------------------------------------------------- |
| `/scaffold-tests`  | Set up Vitest (browser mode or JSDOM) and emit unit tests.                |
| `/scaffold-e2e`    | Set up Playwright and emit per-route smoke + navigation tests.            |
| `/test-api`        | Generate request/response tests for every `src/api/**` handler.           |

### App primitives (additive scaffolds)

| Skill                 | Use when                                                          |
| --------------------- | ----------------------------------------------------------------- |
| `/add-auth`           | Wire session-based email/password auth.                           |
| `/add-db`             | Wire Drizzle ORM (D1, PlanetScale, Neon, Postgres, ...).          |
| `/add-i18n`           | Add locale routing and translation primitives.                    |
| `/add-observability`  | Wire Sentry / OpenTelemetry plus Web Vitals.                      |

## Conventions

- Use `pracht inspect routes --json`, `pracht inspect api --json`, and
  `pracht inspect build --json` as the source of truth instead of globbing
  `src/`. The resolved graph already accounts for groups and inheritance.
- Audit skills produce a report; they never auto-fix.
- Add/scaffold skills generate files but never overwrite an existing config
  without diffing first.
- All skills end with `$ARGUMENTS` so the user can pass additional
  context at invocation time.
