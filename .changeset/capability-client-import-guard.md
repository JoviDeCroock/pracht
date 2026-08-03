---
"@pracht/vite-plugin": patch
---

Fail the build when client code imports a capability module.

Capability modules are server-only, but nothing stripped them the way route
loaders are stripped, so a component importing one directly bundled `run()` and
everything it imports — database clients, secrets — for every visitor. The build
now rejects it and points at the browser projection instead: `callCapability` /
`capabilities` from `virtual:pracht/capabilities`, or `invokeCapability` from
`@pracht/core/server`.

The check matches the capability modules the manifest registers rather than a
`capabilitiesDir` prefix, so a capability registered from anywhere else in the
project is still caught, and ordinary files that merely sit beside capabilities
(shared constants, types) stay importable.
