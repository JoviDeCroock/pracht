---
"@pracht/preact-ssr-precompile": patch
---

Precompiled JSX decodes HTML entities such as `&amp;` and `&nbsp;` in text and attribute strings, as the standard JSX transform does, instead of rendering them escaped twice.
