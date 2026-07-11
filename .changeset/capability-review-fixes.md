---
"@pracht/capabilities": patch
"@pracht/core": patch
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Harden capability dispatch and agent trust edge cases: normalize custom HTTP
paths, fail closed for custom endpoints when registry resolution fails, stream
agent-directory responses within the documented size cap, expose confirmation
fields in browser types, and preserve explicit null capability inputs.
