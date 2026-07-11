---
"@pracht/core": patch
---

Keep Web Bot Auth static-key identities pinned to their configured `agent`
label instead of allowing a signed `Signature-Agent` header to override the
reported `agentDomain`, and refresh capability resolution when the generated
registry changes during dev HMR.
