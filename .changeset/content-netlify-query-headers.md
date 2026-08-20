---
"@pracht/content": patch
"@pracht/adapter-netlify": patch
---

Compile content route modules carrying Pracht or HMR query parameters while
continuing to preserve Vite's `?raw` and `?url` resource representations.

Apply generated build headers, including content artifact media types, to
Netlify paths that bypass the Pracht function and are served by the static
layer.
