---
"@pracht/core": patch
---

A finished request no longer keeps its `signal` and the loader-budget timer alive for the rest of `loaderTimeoutMs`: the budget now ends once the response, a streamed body, and any `waitUntil` work have settled.
