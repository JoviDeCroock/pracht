---
title: Testing agent flows
lead: Script agent tasks as `pracht eval` scenarios and run them in CI over HTTP, your remote MCP endpoint, or WebMCP in Chrome.
---

Write scenarios in `evals/*.eval.json` and run `pracht eval` against your running app; it exits 1 on any failed expectation. `examples/basic` ships this one:

```jsonc [evals/notes.eval.json]
{
  "name": "notes agent flow",
  "task": "Search notes, hit a validation failure, then purge with the confirmation flow.",
  "steps": [
    {
      "capability": "notes.search",
      "input": { "query": "capabilities" },
      "expect": { "ok": true, "status": 200 }
    },
    {
      "capability": "notes.search",
      "input": { "query": "" },
      "expect": { "ok": false, "status": 400, "errorCode": "invalid_input" }
    },
    {
      "capability": "notes.create",
      "input": { "title": "Purge target", "body": "Created by pracht eval." },
      "expect": { "ok": true, "output": { "note": { "title": "Purge target" } } }
    },
    {
      "capability": "notes.purge",
      "input": {
        "titlePrefix": "Purge target",
        "idempotencyKey": "$steps[2].data.note.id"
      },
      "expect": { "ok": false, "status": 409, "errorCode": "confirmation_required" }
    },
    {
      "capability": "notes.purge",
      "input": {
        "titlePrefix": "Purge target",
        "idempotencyKey": "$steps[2].data.note.id"
      },
      "confirm": "$steps[3].error.confirmationToken",
      "expect": { "ok": true }
    }
  ]
}
```

`$steps[n].<path>` carries values between steps, and `confirm` threads the prepare/commit token. `--start` launches your app, waits for it to answer, runs the scenarios, and stops it:

```sh
pracht eval --start "pracht preview"    # runs evals/**/*.eval.json

# …or manage the server yourself:
pracht preview                          # in another terminal
pracht eval --url http://localhost:3000
```

Each step reports the capability's own dispatch status and latency:

```
PASS  notes agent flow  (evals/notes.eval.json)
  ✓ 1. notes.search → ok (200, 12ms)
  ✓ 2. notes.search → invalid_input (400, 3ms)
  ✓ 3. notes.create → ok (200, 5ms)
  ✓ 4. notes.purge → confirmation_required (409, 4ms)
  ✓ 5. notes.purge → ok (200, 6ms)

PASS  notes agent flow over MCP  [mcp]  (evals/notes-mcp.eval.json)
  ✓ 1. notes.search → ok (200, 15ms)
  ✓ 2. notes.search → invalid_input (400, 4ms)
  ✓ 3. notes.create → ok (200, 7ms)
  ✓ 4. notes.purge → confirmation_required (409, 5ms)
  ✓ 5. notes.purge → ok (200, 8ms)

2 scenario(s) passed, 0 failed.
```

## The same scenario over remote MCP

Add `"transport": "mcp"` to drive the [remote MCP endpoint](/docs/mcp-tools#remote-mcp-tools-for-agents-without-a-browser) like a host: an `initialize` handshake, then one `tools/call` per step with the projected tool name (`notes.search` → `notes_search`).

```jsonc [evals/notes-mcp.eval.json — transport keys]
{
  "name": "notes agent flow over MCP",
  "transport": "mcp",              // default is "http"
  "mcpPath": "/mcp",               // optional; only if you moved the endpoint
  "mcpHeaders": {                    // when agents.mcp.auth protects the endpoint
    "authorization": "Bearer test-token"
  },
  "steps": [
    { "capability": "notes.search", "input": { "query": "roadmap" } },
    {
      "capability": "notes.search",
      "input": { "query": "" },
      // The identical expectation the HTTP scenario writes.
      "expect": { "ok": false, "status": 400, "errorCode": "invalid_input" }
    }
  ]
}
```

Expectations are portable across transports: `status` is the capability's dispatch status, not the JSON-RPC `200`. `signAs` signs MCP requests too.

- `mcpHeaders.authorization` is sent on every request; a step's own `authorization` header overrides it. Inject a test token in CI.
- Any header other than `authorization` fails the scenario, as does a capability without `expose.mcp`.
- Destructive `confirm` steps need [`agents.mcp.destructive` and an approval store](/docs/mcp-tools#destructive-tools).

## Scenarios over WebMCP

Set `"transport": "webmcp"` and a `"webmcpRoute"` to launch Chrome, discover the page tool on that route, and run your steps:

```jsonc [evals/notes-webmcp.eval.json]
{
  "name": "notes through WebMCP",
  "transport": "webmcp",
  "webmcpRoute": "/notes",
  "steps": [
    {
      "capability": "notes.search",
      "input": { "query": "roadmap" },
      "expect": { "ok": true }
    },
    {
      "capability": "notes.search",
      "input": { "query": "roadmap" },
      "cancelAfterMs": 0,
      "expect": { "ok": false, "status": 499, "errorCode": "cancelled" }
    }
  ]
}
```

`cancelAfterMs` checks that host cancellation reaches your dispatch. WebMCP scenarios reject headers, confirmation tokens, and `signAs`, and need Chrome 150 or later; pin the binary in CI with `--browser /path/to/chrome`.

To unit-test the dispatch pipeline with `createCapabilityTestHost()`, see the [Testing recipe](/docs/recipes/testing).

## Measure an agent completing a task

A scripted scenario names each capability and its inputs. To measure discovery and recovery, give an agent a task such as “create a project and verify it exists”, let it choose its calls, then check the resulting application state independently.

The Pracht repository includes `bench/tasks/run.mjs` for this separate workflow. It runs a configured agent command in fresh checkouts of a pinned fixture, executes acceptance checks, and records repeated trial results. See the [task benchmark guide](https://github.com/JoviDeCroock/pracht/tree/main/bench/tasks).

Record completion rate, interventions, repair cycles, elapsed time, and tool/token counts when your host exposes them. Keep versions and fixtures fixed, retain failed trials, and compare equivalent tasks. Missing telemetry is unknown, not zero. Continue using `pracht eval` for repeatable protocol regression checks.
