---
"@pracht/cli": minor
---

`@pracht/cli` no longer installs the MCP SDK or `playwright-core`, which cuts a fresh install from 103 packages (45 MB) to 8 (13 MB). `pracht verify webmcp` and WebMCP `pracht eval` scenarios now need `playwright-core` as a dev dependency of the app (`npm install -D playwright-core`), and say so when it is missing.
