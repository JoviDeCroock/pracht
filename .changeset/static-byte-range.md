---
"@pracht/adapter-netlify": patch
"@pracht/adapter-static": patch
---

Static files served by the Netlify function and by `pracht preview` for static exports now answer byte-range requests with `206`, as the Node server does.
