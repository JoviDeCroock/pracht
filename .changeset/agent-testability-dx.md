---
"@pracht/core": minor
"@pracht/cli": minor
---

Make agent surfaces easier to test and discover

- `createCapabilityTestHost()` (`@pracht/core`): run the full capability dispatch pipeline in unit tests without a server. `invoke()` mirrors `invokeCapability()`; `request()` mirrors the HTTP projection, including Web Bot Auth policy — with simulated `agent` identities, no RFC 9421 signing needed — and the destructive prepare/commit confirmation flow. `resolveRegistryModule` is now part of the public API.
- `pracht eval --start "<command>"`: launches the app, waits for it to answer at `--url` (default `http://localhost:3000`), runs the scenarios, then stops the whole process group — no second terminal needed.
- The `pracht dev` banner now lists registered capabilities (name, effect, exposure, dispatch path) next to Routes and API, and the command accepts `--port` (the previously documented positional form still works).
- Fixed `pracht inspect capabilities` — and the new banner and the MCP `inspect_capabilities` tool — reporting `effect=n/a transports=private` for every capability: manifest-relative module paths now load through the virtual server module's registry instead of raw `ssrLoadModule`.
