---
"@pracht/capabilities": patch
---

`createCapabilityHost()` accepts `loaderTimeoutMs` to set each request's budget, as `defineApp()` does, instead of always using 30 seconds.
