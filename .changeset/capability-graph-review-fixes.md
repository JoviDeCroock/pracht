---
"@pracht/capabilities": patch
"@pracht/core": patch
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Fix issues found reviewing the capability graph work:

- **`@pracht/capabilities`**: `const`/`enum` validation of object-valued schemas no longer accepts a `{"__proto__": {}}` payload as a match (`jsonEquals` now uses an own-property check). The shared static extractor analyzes the module's *default-exported* `defineCapability()` call rather than the first one in the file (a helper capability before the exported one no longer shadows it), and the brace/comma scanners are regex-literal-aware so a `}`/`]`/`,` inside a regex such as `/\}/` no longer truncates the extracted definition.
- **`@pracht/core`**: `defineApp({ agents })` validates the Web Bot Auth `policy` (rejecting typos like `"requre"` that would fail open) and non-positive numeric trust settings. The destructive prepare/commit confirmation gate now runs inside the capability middleware chain, so rate-limiting middleware sees prepare and invalid-token attempts. `invokeCapability()` and the test host return an `internal_error` envelope when middleware throws instead of rejecting. Islands-mode routes now revalidate (full reload) after a successful non-`read` capability call.
- **`@pracht/vite-plugin`**: the `/_pracht` devtools endpoint resolves manifest-relative capability refs through the app registry (matching `pracht inspect`); the client and islands-client entries invalidate when a capability's WebMCP exposure changes in dev; root-relative capability refs (`/src/...`) resolve in `pracht build`; an explicit `llmsTxt: undefined` is treated as disabled; and a `public/llms.txt` colliding with the `llmsTxt` option now warns about the dev/production precedence difference.
- **`@pracht/cli`**: `pracht verify` masks comments before counting manifest registrations (commented-out registrations no longer count) and warns instead of silently passing when a capability's `expose` is not an inline literal (so the destructive-exposure checks are not skipped). `pracht typegen` guards `--capabilities-out` against basename collisions with the other generated files. `pracht eval --start` stops the server on Ctrl+C and kills the full process tree on Windows. An empty `PORT=` env var falls back to the default port instead of erroring.
