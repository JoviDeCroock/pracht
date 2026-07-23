---
title: The Agentic Web
lead: The web has two users now — people, and the agents acting on their behalf. pracht projects one explicit app graph to both — components for humans, typed and trust-gated tools for agents, with discovery, identity, confirmation, audit, and CI proof built in.
breadcrumb: Agents
prev:
  href: /docs/performance
  title: Performance
next:
  href: /docs/llms
  title: LLM Content
---

## The Web Has Two Users Now

Today, when an AI agent needs to do something on a website — book a slot, file a ticket, buy the thing — it does what a scraper does: load the page, read the DOM, guess which `<button>` is real, and click. That's slow, brittle, and anonymous. And the same guessing that fills a search box can also hit "delete account." The site owner can't tell agents from humans, can't say which operations are safe, and finds out what happened from the support queue.

pracht's bet: your app already knows its own operations — it has just never written them down in a form a machine could trust. So you write each one down **once**:

```ts [src/capabilities/book-appointment.ts]
import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Book appointment",
  description: "Reserve an open slot with the given service and time.",
  input: { /* JSON Schema */ },
  output: { /* JSON Schema */ },
  effect: "write",
  middleware: ["auth"],
  expose: { http: true, webmcp: true },
  async run({ input, context }) { /* your business logic */ },
});
```

One contract. pracht projects it everywhere.

---

## One Contract, Four Callers

**Your own code calls it.** The loader behind the booking page runs `invokeCapability("appointments.book", …)` — same validation, same middleware, same pipeline. The human UI and the agent surface can't drift apart, because they are the same function.

**The browser calls it.** Your form's submit handler uses `callCapability()` against the generated endpoint. The capability module itself never ships to the client — only its name and URL.

**An agent in the user's tab calls it.** With `expose.webmcp`, the page registers the operation as a [WebMCP](https://developer.chrome.com/docs/ai/webmcp) page tool. The agent stops guessing at your DOM and instead sees: *"book_appointment — reserve an open slot. Input: service, time."* It acts as the signed-in user, in their session — and every check still runs on your server.

**An agent that has never seen your site finds it.** The generated [`/llms.txt`](/docs/llms) lists every page (with `Accept: text/markdown` negotiation for clean source instead of scraped layout), every API route, and every capability with its endpoint, effect class, and description. An agent goes from "never heard of this site" to a validated, typed call in two requests. And when it gets the input wrong, the error comes back path-scoped — `/limit: must be <= 20` — so it self-corrects instead of flailing.

The full API lives in [Capabilities](/docs/capabilities).

---

## Trust Is the Framework's Job

Turning schemas into tools is commodity work. What makes an agent surface deployable rather than a demo is the trust layer — and in pracht it ships in the framework, so it's the default, not a bolt-on:

- **Who is calling?** Agents signing with Web Bot Auth ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) HTTP Message Signatures — the standard the major CDNs are rolling out) surface as `context.agent`, cryptographically verified. Start with `policy: "observe"` to watch who's calling; flip a capability to `agentPolicy: "require"` when it should answer verified agents only.
- **May they do this?** Effect classes are load-bearing, not documentation. A `destructive` capability cannot run on first contact — the server answers `409 confirmation_required` with a token bound to this caller, this operation, this exact input. Only a deliberate second call with matching input commits. An agent physically cannot "accidentally" purge your data; the framework — not the agent's manners — enforces it.
- **What happened?** Every dispatch, HTTP or internal, emits one structured audit event: capability, effect, transport, outcome, latency, and the verified identity. Your agent traffic is a queryable log, not a mystery in the access logs.
- **Will it keep working?** `pracht eval` runs scripted agent tasks — search, fail validation, get the 409, carry the token, commit — against your live app in CI. When someone refactors the flow, the build tells you agents are broken before the agents do.

The full API lives in [Agent Trust](/docs/agent-trust).

---

## Try It in Five Minutes

Everything above is testable with nothing but `curl`. The repository's [`examples/basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic) app registers five capabilities around a notes store:

```sh
git clone https://github.com/JoviDeCroock/pracht && cd pracht
pnpm install && pnpm build
cd examples/basic
PRACHT_CONFIRMATION_SECRET=dev-secret pnpm pracht dev
```

Discover the app the way an agent would, then call a capability:

```sh
curl -s http://localhost:3000/llms.txt

curl -s -X POST http://localhost:3000/api/capabilities/notes/search \
  -H 'content-type: application/json' -d '{"query":"capabilities"}'
# { "ok": true, "data": { "notes": [...] } }
```

Trip the guardrails — invalid input answers with path-scoped issues, and the destructive purge refuses to run without a confirmed second call:

```sh
curl -s -X POST http://localhost:3000/api/capabilities/notes/search \
  -H 'content-type: application/json' -d '{"query":"","limit":99}'
# { "ok": false, "error": { "code": "invalid_input", "issues": [
#   { "path": "/query", "message": "must be at least 1 character(s) long" },
#   { "path": "/limit", "message": "must be <= 20" } ] } }

curl -s -X POST http://localhost:3000/api/capabilities/notes/purge \
  -H 'content-type: application/json' -d '{"titlePrefix":"Old"}'
# → 409 { "error": { "code": "confirmation_required", "confirmationToken": "v1...." } }
# Repeat with -H "x-pracht-confirm: <token>" and identical input to commit.
```

Then prove the whole flow as a scripted scenario (with `--start "pracht preview"` it even manages the server itself):

```sh
pnpm pracht eval --url http://localhost:3000
# PASS  notes agent flow  (evals/notes.eval.json)
#   ✓ 1. notes.search → ok (200)
#   ✓ 2. notes.search → invalid_input (400)
#   ✓ 3. notes.create → ok (200)
#   ✓ 4. notes.purge → confirmation_required (409)
#   ✓ 5. notes.purge → ok (200)
```

Visit [`/notes`](http://localhost:3000/notes) in the browser to see the human projection of the same contracts, and read the [Testing recipe](/docs/recipes/testing) for Vitest, Playwright, and CI patterns — including how to fake the WebMCP API and sign Web Bot Auth requests in tests.

---

## Where This Goes Next

The same contracts are one projection away from a remote MCP endpoint (for agents that never open a browser) and MCP Apps views (capabilities that return Preact UI into an agent's chat). Write the operation down once; every new agent surface is a build target.

The one-liner: other frameworks render your app for humans and leave agents to scrape it. pracht projects one explicit app graph to both — components for people, typed and trust-gated tools for agents.
