---
"@pracht/adapter-netlify": patch
---

Netlify serves prerendered pages whose paths contain non-ASCII or escaped characters (such as `/posts/caf%C3%A9`) from the static build instead of rendering them in the function on every request.
