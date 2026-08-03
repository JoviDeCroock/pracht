---
"@pracht/capabilities": patch
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Give the capability projection rules one home, and cross-check them in typegen.

The HTTP path, effect, WebMCP exposure, and input schema of a capability were
derived twice: once by the Vite plugin's static analysis (capability modules
must never enter the client graph, so it cannot execute them) and once by the
app graph, which loads the modules. Both now share
`extractCapabilityProjection` from `@pracht/capabilities/static`.

`pracht typegen` cross-checks the executed graph against that static pass and
fails when they disagree — including when static analysis cannot read an exposed
capability at all, which is what a computed `expose` or `effect` looks like.
Without the check, generated types could describe an endpoint the client bundle
never registers.
