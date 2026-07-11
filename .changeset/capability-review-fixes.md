---
"@pracht/capabilities": patch
"@pracht/core": patch
"@pracht/vite-plugin": patch
"@pracht/cli": patch
---

Harden capability dispatch and agent trust edge cases: normalize custom HTTP
paths, fail closed for custom endpoints when registry resolution fails, stream
agent-directory responses within the documented size cap, expose confirmation
fields in browser types, preserve explicit null capability inputs, reject malformed
schemas, inherited-property validation bypasses, and non-JSON object values, honor
middleware replacement responses, and keep test-host agent context aligned with
production.
