# Agent Workflow — provable authoring, reviewable changes

Pracht is designed to be operated by coding agents as much as by humans. That only
works if two things hold:

1. **An agent can author correctly without guessing** — conventions are explicit,
   scaffolding is canonical, and there is a deterministic oracle to iterate against.
2. **A human can review cheaply and trust the result** — the reviewable surface is
   an intent-level diff plus machine-enforced invariants, not a pile of code the
   reviewer must re-derive.

This document describes the four mechanisms that implement this and how they fit
together. See [MCP.md](MCP.md) for the MCP tool surface agents use to drive them.

---

## 1. The app-graph snapshot and `pracht plan`

Because pracht resolves the whole app into an explicit graph (routes, render modes,
shells, middleware, API endpoints, capabilities, constraints), "what did this change
do" has a canonical answer that is not the raw code diff.

- `.pracht/app-graph.json` is a committed, canonically-ordered serialization of the
  resolved graph — a route-graph lockfile. `pracht plan --write` refreshes it.
- `pracht plan [--base <ref>]` (default `origin/main`) resolves the **live** graph
  through Vite (the same resolution `pracht inspect` and the dev server use), reads
  the snapshot committed at the base ref via `git show`, and prints a structural
  diff:

  ```
  + route /pricing  render=isg  shell=public  middleware=[]  (4.2kb gz / 25.0kb limit)
  ~ route /dashboard  middleware: [auth] → [auth, audit]
  - route /legacy
  + api   /api/webhooks/stripe  methods=[POST]
  ! capability notes.purge  now exposed via mcp — reachable by agents
  ~ capability notes.search  HTTP path /api/capabilities/notes/search → /api/search
  + constraint require-middleware /app/**  middleware=["auth"]
  ```

- Capability lines answer the question a route diff cannot: **did this change
  widen what agents can reach?** A `!` marks a widening — a new exposure, a
  `destructive` capability reclassified out of the confirmation flow, an
  `agentPolicy` downgraded from `require`, middleware dropped, or an input schema
  that now accepts more than it did (a dropped `required` field, an opened
  `additionalProperties`, a raised or removed bound, including nested ones like
  `input.limit: maximum raised (50 → 5000)`). Narrowings and removals stay quiet.
  Enabling `agents.mcp` is also a widening because it turns every declared
  `expose.mcp` capability from graph metadata into a remotely served tool; the
  plan records endpoint enablement, moves, and removal explicitly.
  When anything widened, `--markdown` puts a callout above the diff instead of
  leaving it to be spotted in the fence.

- `--markdown` emits the same diff fenced for a PR comment; `--json` is the full
  structured payload (`PlanReport`). Per-route gzip sizes are annotated when the
  last build produced a budget report.
- `pracht verify` fails when the snapshot is stale, so a committed snapshot is
  always trustworthy — the plan in a PR cannot drift from the code.
- A snapshot committed before capabilities were tracked simply has none, so the
  first plan after upgrading reports every capability as added; `pracht plan
  --write` settles it.

Review flow this enables: the reviewer reads the plan first ("did the agent add
exactly the route it was asked to, behind the right middleware?"), then reads only
the component/loader bodies. Collateral changes the task didn't mention show up as
extra plan lines immediately.

Implementation: `packages/cli/src/graph-snapshot.ts` owns snapshot persistence and
semantic comparison, `packages/cli/src/graph-plan-format.ts` owns terminal/Markdown
presentation and build-budget annotations, and `packages/cli/src/graph-types.ts`
holds their shared contracts. `packages/cli/src/commands/plan.ts` orchestrates
them, and `packages/cli/src/app-server.ts` provides shared Vite boot.

## 2. Constraints — invariants the machine enforces

`defineApp({ constraints })` declares invariants over the resolved route graph.
The human reviews a few constraint lines once; from then on **no author, human or
LLM, can merge a violation** because `pracht verify` (run in CI) fails.

```ts
import { defineApp, forbidRenderMode, requireHead, requireMiddleware, requireShell } from "@pracht/core";
// The manifest is bundled into the client too, so these come from the
// browser-safe entry as well — no separate import path needed.

export const app = defineApp({
  // ...
  constraints: [
    requireMiddleware("/app/**", "auth"),   // every /app route needs auth
    requireShell("/app/**", "app"),         // ...and the app shell
    forbidRenderMode("/app/**", "ssg", "isg"), // no accidentally-static private pages
    requireHead("**"),                      // every route has head() (own or shell)
  ],
});
```

Pattern semantics (segment-wise against the declared path): `*` matches exactly one
segment (including `:param`), a trailing `**` matches zero or more segments,
`"**"` alone matches every route. Constraints are carried through
`resolveApp()` so the CLI evaluates the same graph the runtime serves.
Evaluation is pure (`evaluateConstraints` in `packages/framework/src/constraints.ts`);
the CLI supplies source-level lookups such as the `head()` export check
(`packages/cli/src/verification-graph.ts`). Manifest router only for now.

Verification only boots the app graph when the app opts in (constraints declared
or a snapshot committed), so `pracht verify` stays fast for apps that use neither.

## 3. Output-level proof — generated smoke tests

`pracht generate route` (CLI and MCP `generate_route`) emits a Playwright smoke
test at `e2e/<route-id>.spec.ts` whenever the app has a Playwright setup
(`playwright.config.*` or an `e2e/` directory): the route serves with a
non-error status and renders its heading. Dynamic segments get example values
matching the `getStaticPaths` stub (`/blog/:slug` → `/blog/example-slug`).
`--test` forces emission, `--no-test` skips it.

Generated tests import `@playwright/test`. Existing Playwright apps already
have that dependency; when `--test` forces a smoke test in an app without it,
the generator prints the install step (`pnpm add -D @playwright/test`).

The point: every LLM-authored route arrives with a falsifiable claim attached.
"The route exists and renders" is proven by CI, not asserted in a PR description.

## 4. `pracht report` and the authoring guide

- `pracht report [--base ref] [--out file]` assembles the factual half of a PR
  description from machine truth: the plan diff, `pracht verify` results, and the
  budget table. Agents (and humans) add the "why"; the "what" is generated and
  therefore cannot misrepresent the diff.
- `pracht llms` prints the embedded authoring guide (project layout, conventions,
  the verify → plan → report loop); `pracht llms --write` writes `llms.txt` into
  the app root. The MCP `get_docs` tool returns the same text, so any MCP client
  gets the conventions without repo-local skills. Source:
  `packages/cli/src/authoring-guide.ts`.

---

## CI recipe

```yaml
- run: npx pracht verify            # constraints + snapshot freshness + wiring
- run: npx pracht build --analyze   # budgets fail the build
- run: npx playwright test          # generated smoke tests + your e2e suite
- run: npx pracht plan --markdown --base origin/main > plan.md
- run: gh pr comment "$PR" --body-file plan.md   # intent-level diff for reviewers
```

## Design notes

- **Snapshot over historical resolution.** `pracht plan` reads the base graph from
  the committed snapshot rather than re-resolving the app at the base ref (which
  would need a worktree checkout plus that ref's dependency tree). The snapshot is
  itself part of the PR diff — reviewers see the graph change in git even without
  running anything — and verify's staleness check keeps it honest.
- **Constraints live in the manifest** so they travel with the graph, appear in
  plan diffs when they change (`+ constraint ...`), and are resolved by the same
  `resolveApp()` path the runtime uses.
- **Weakening a constraint is a policy change.** The authoring guide instructs
  agents to never delete or loosen a constraint to make verification pass;
  constraint edits surface as their own plan lines for the reviewer.
