---
"@pracht/core": patch
"@pracht/capabilities": patch
---

A request answered with a 4xx, including a capability call rejected before it runs, no longer keeps its `signal` and request state in memory until the budget runs out.
