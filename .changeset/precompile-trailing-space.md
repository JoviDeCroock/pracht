---
"@pracht/preact-ssr-precompile": patch
---

Precompiled JSX keeps a space at the end of an element's text, such as `<span>{label} </span>`, as the standard JSX transform does.
