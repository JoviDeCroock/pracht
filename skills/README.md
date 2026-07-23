# Pracht Skills

Repo-local Claude Code skills for people building applications with pracht.
They are published for end users at
[`/.well-known/agent-skills/index.json`](https://pracht.resynapse.dev/.well-known/agent-skills/index.json),
seeded into new apps by `create-pracht`, and loaded for contributors in this
repo via the `.claude/skills` symlink.

Skills live one directory per skill, each with a `SKILL.md` defining
frontmatter (`name`, `version`, `description`, `allowed-tools`) and an
action-oriented body. Invoke a skill in Claude Code with `/<skill-name>`.
Skills with framework-generic names carry a `pracht-` prefix so they don't
collide with other skill packs installed in the same app.

## Framework & migration

| Skill              | Use when                                                     |
| ------------------ | ------------------------------------------------------------ |
| `/pracht-scaffold` | Generate routes, shells, middleware, or API handlers.        |
| `/pracht-debug`    | Investigate route matching, loader, rendering, or HMR bugs.  |
| `/pracht-deploy`   | Configure an adapter and deploy to Node, Cloudflare, Vercel. |
| `/migrate-nextjs`  | Convert a Next.js app (App or Pages Router) to pracht.       |
| `/upgrade-pracht`  | Upgrade `@pracht/*` packages safely, mapping breaking changes. |

## Audit & review

| Skill               | Use when                                                            |
| ------------------- | ------------------------------------------------------------------- |
| `/audit-loaders`    | Check loaders for serializability, leaked secrets, browser-only APIs. |
| `/audit-shells`     | Verify shell composition: `Loading()`, `head()`, no document tags.  |
| `/audit-islands`    | Find over-hydration and islands misuse; recommend hydration modes.  |
| `/audit-auth`       | Find protected routes missing auth middleware.                      |
| `/audit-csrf`       | Verify CSRF posture on top of the built-in same-origin enforcement. |
| `/audit-headers`    | Find weakened security headers and missing HSTS/CSP; CSP suggestion. |
| `/audit-secrets`    | Detect env vars / secrets reaching the client bundle.               |
| `/audit-redirects`  | Open-redirect detection in loaders, middleware, navigation.         |
| `/audit-deps`       | npm/pnpm audit mapped to which routes use the vulnerable package.   |
| `/audit-bundles`    | Per-route client payload size and code-splitting recommendations.   |
| `/audit-seo`        | `head()` coverage, OG cards, sitemap, robots.txt.                   |
| `/audit-a11y`       | Per-route axe-core run with WCAG 2.1 AA defaults.                   |
| `/tune-render-mode` | Recommend SSG/ISG/SSR/SPA per route based on loader contents.       |
| `/pre-deploy`       | Adapter-aware pre-deployment checklist.                             |

## Testing scaffolds

| Skill              | Use when                                                                  |
| ------------------ | ------------------------------------------------------------------------- |
| `/scaffold-tests`  | Set up Vitest (browser mode or JSDOM) and emit unit tests.                |
| `/scaffold-e2e`    | Set up Playwright and emit per-route smoke + navigation tests.            |
| `/pracht-test-api` | Generate request/response tests for every `src/api/**` handler.           |

## App primitives (additive scaffolds)

| Skill                 | Use when                                                          |
| --------------------- | ----------------------------------------------------------------- |
| `/add-auth`           | Wire session-based email/password auth.                           |
| `/add-db`             | Wire Drizzle ORM (D1, PlanetScale, Neon, Postgres, ...).          |
| `/add-i18n`           | Add locale routing and translation primitives.                    |
| `/add-observability`  | Wire Sentry / OpenTelemetry plus Web Vitals.                      |
| `/typed-routes`       | Generate and adopt route-id based typed links/navigation.         |
| `/configure-isg`      | Wire ISG revalidation (time + webhook) per adapter.               |

## Conventions

- Use `pracht inspect routes --json`, `pracht inspect api --json`, and
  `pracht inspect build --json` as the source of truth instead of globbing
  `src/`. The resolved graph already accounts for groups and inheritance.
  Route entries include `render`, `hydration`, `prefetch`, and `speculation`
  (`null` means the framework default applies); API entries include
  `hasDefaultHandler` for default-export dispatchers.
- The same capabilities are available as native MCP tools via `pracht mcp`
  (inspect, doctor, verify, and generate) — see [docs/MCP.md](../docs/MCP.md).
  Prefer the MCP tools when the client has the server registered; every skill
  carries a reminder near its first CLI invocation.
- State prerequisites: `pracht inspect` needs a vite config that registers the
  pracht plugin; `inspect build`, the analyze report, `headers.json`, and the
  env-safety report all need a prior `pracht build`.
- Use `pracht typegen` to refresh `src/pracht.d.ts` and
  `src/pracht-routes.ts` after route ids or paths change — and
  `src/pracht-capabilities.d.ts` after capability schemas change; use
  `pracht typegen --check` in verification/CI. Generating skills end their
  verification with `pracht verify --json`.
- Audit skills produce a report; they never auto-fix. They report with a
  shared `error` / `warn` / `info` severity scale (domain-specific verdicts
  may appear as a secondary column) and open by stating what the framework
  already guarantees before auditing the opt-outs. `/tune-render-mode` is a
  tune skill, not an audit: it proposes diffs and applies them only after
  user confirmation.
- Add/scaffold skills generate files but never overwrite an existing config
  without diffing first.
- All skills end with `$ARGUMENTS` so the user can pass additional
  context at invocation time.
- `skills/skills.test.ts` enforces these conventions in CI (frontmatter shape,
  `$ARGUMENTS`, tool policy, and that referenced CLI subcommands, MCP tools,
  and build-output paths actually exist).
