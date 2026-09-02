---
"@pracht/core": patch
---

`HeadArgs` and `HeadersArgs` default their context type parameter to the registered app context, matching `LoaderArgs`, instead of `any`.
