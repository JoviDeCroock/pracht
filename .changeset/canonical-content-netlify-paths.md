---
"@pracht/adapter-netlify": patch
"@pracht/content": patch
---

Match content sources through symbolic collection roots after Vite canonicalizes their module IDs.

Reject exact header manifest paths that Netlify would interpret as wildcard or placeholder rules.
