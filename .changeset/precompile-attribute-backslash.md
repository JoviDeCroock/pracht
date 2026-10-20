---
"@pracht/preact-ssr-precompile": patch
---

Precompiled static attributes keep backslashes and control characters such as `title="a\b"` as written, instead of rendering JavaScript escape sequences like `a\\b`.
