---
"@pracht/core": patch
---

Fix Markdown-for-Agents negotiation so route loaders and document headers still run before returning markdown responses, preventing loader auth/header bypass.
