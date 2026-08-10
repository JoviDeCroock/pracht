# Showcase: Launchpad — one product, two audiences

A fictional project-management tool that demonstrates the whole capability graph
and agent trust layer in one small Preact app: six operations defined once, then
projected to the browser, to progressively-enhanced forms, to in-page WebMCP
agents, to signed remote callers, and to MCP tools at `/mcp` — behind one set
of rules.

It is still a per-route-rendering demo too (SSG, SSR, SPA in one manifest);
that story just stopped being the headline.

## Run it

```bash
pnpm install && pnpm build          # from the repo root: build the packages first
cd examples/showcase

pnpm dev                            # http://localhost:5173
pnpm agent --url http://localhost:5173   # a signed agent walks the whole flow
pnpm eval                           # the same flow as a CI check
pnpm verify                         # constraints, contracts, graph snapshot
pnpm inspect                        # the capability graph, with schemas
```

## The two-minute tour

1. **`/`** — the pitch, and the four surfaces one contract serves.
2. **`/playground`** — call every capability from the browser. `agent.whoami`
   says you are unverified; `agent.brief` refuses you outright with `401
   agent_required`; `projects.search` runs through `useCapability()`;
   `projects.create` is a `<Form capability>`.
3. **Sign in** (the header button — it just sets a cookie) and request an archive
   from `/app`. You get a confirmation token, then `confirmation_pending`.
4. **`/app/approvals`** — approve the proposal as a human. Go back and commit:
   it runs, once. Replay the same token and it is refused as `already_used`.
5. **`/app/audit`** — every dispatch above, with its transport, outcome, latency
   and verified agent identity.
6. **`POST /mcp`** — `tools/list` projects the same graph, minus
   `projects_archive`: `destructive` capabilities are filtered out of the MCP
   tool list however they are declared. A cookie or an `Origin` header on that
   endpoint is a 403.
7. **`node scripts/agent.mjs`** — the same journey as a cryptographically
   verified agent, over the HTTP projection *and* `/mcp`, stopping dead at the
   human approval just like you did.

## What each piece demonstrates

| File | Feature |
| --- | --- |
| `src/routes.ts` | Capability registration, `agents.webBotAuth`, `agents.confirmation.mode: "human"`, `agents.mcp`, machine-enforced `constraints` |
| `src/capabilities/projects-search.ts` | `read` — HTTP + WebMCP + remote MCP, called from a loader, the browser, and agents |
| `src/capabilities/projects-create.ts` | `write` behind named rate-limit middleware; the target of `<Form capability>` |
| `src/capabilities/projects-deploy.ts` | `write` with a caller-supplied `idempotencyKey` — the retry story agents need |
| `src/capabilities/projects-archive.ts` | `destructive` — HTTP-only, prepare/commit, human approval |
| `src/capabilities/agent-whoami.ts` | `context.agent`, the app-wide `observe` policy |
| `src/capabilities/agent-brief.ts` | `agentPolicy: "require"` — verified agents only, on HTTP and MCP alike |
| `src/middleware/rate-limit.ts` | Per-principal limits, the documented middleware seam |
| `src/server/agent-runtime.ts` | `setCapabilityAuditHook`, `setCapabilityApprovalStore`, `setCapabilityApprovalPrincipalResolver` |
| `src/routes/approvals.tsx` + `src/api/admin/approvals.ts` | The application's own approval inbox — pracht deliberately ships none |
| `src/routes/audit.tsx` | The structured audit trail |
| `src/routes/agents.tsx` | Markdown content negotiation (`Accept: text/markdown`) |
| `src/components/archive-flow.tsx` | The typed client forcing `{ prepare }` / `{ confirm }` at the call site |
| `evals/*.eval.json` | `pracht eval` scenarios, including "the agent cannot archive alone" |
| `scripts/agent.mjs` | An RFC 9421 Web Bot Auth agent speaking both the HTTP projection and MCP, no dependencies |
| `vite.config.ts` | `llmsTxt` emission from the resolved graph |

## Per-route rendering, still

| Route | Mode | Why |
| --- | --- | --- |
| `/`, `/agents`, `/blog/:slug`, `/pricing` | **SSG** | Pre-built at deploy, served from the CDN. Pricing's plans are hard-coded; add a `revalidate` policy and it becomes ISG. |
| `/playground`, `/app`, `/app/projects/:id`, `/app/approvals`, `/app/audit` | **SSR** | Per-request data. |
| `/app/settings` | **SPA** | Client-only interactive UI. |

## The signed agent

`scripts/agent.mjs` derives an Ed25519 keypair from a seed constant; the public
half is pinned in `defineApp({ agents: { webBotAuth: { keys } } })`. Nothing
secret is committed — run `node scripts/agent.mjs --keys` to print what the
manifest trusts.

```bash
node scripts/agent.mjs                       # against localhost:5173
node scripts/agent.mjs --url https://…       # against a deployment
node scripts/agent.mjs --unsigned            # watch agent.brief answer 401
```

It walks the HTTP projection and then `/mcp` with the same signature headers,
which is the point: `agent.brief` answers a signed caller and denies an unsigned
one on both, because `agentPolicy` belongs to the capability rather than to the
transport that reached it.

## Known demo limitations

- **State is in memory.** Projects, approvals and the audit trail live in module
  scope, so on a serverless deployment they are per-instance and vanish when an
  instance recycles. `/playground` has a reset button that restores all three
  stores on the current instance. A real app needs a database, and
  `createMemoryApprovalStore()` in particular must be replaced by a store with
  conditional writes (D1, Durable Objects, Postgres, Redis) — see
  [docs/AGENT_TRUST.md](../../docs/AGENT_TRUST.md#writing-a-store).
- **The confirmation secret comes from the environment.** Set
  `PRACHT_CONFIRMATION_SECRET`; without it the app falls back to a committed
  development secret and says so loudly, which makes confirmation tokens
  forgeable. The `pnpm` scripts supply a development value so `pracht dev`,
  `pracht verify` and `pracht eval` work with no setup.
- **The session cookie is a login button.** It is not authentication and the
  approval principal derived from it is caller-controlled. A real resolver must
  read a verified session.

## Own TypeScript program

`examples/showcase/tsconfig.json` exists because `pracht typegen` emits
`declare module "@pracht/core"` augmentations. Those are global to a TypeScript
program, so two apps in one `tsc` invocation fight over
`Register["capabilities"]`. The root program holds `examples/basic`'s
registration; this app holds its own, and the root `pnpm typecheck` runs both.

## Deploy

```bash
pnpm build                          # → .vercel/output
pnpx vercel deploy --prebuilt
```
