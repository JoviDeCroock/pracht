---
"@pracht/cli": patch
---

A static export whose pages each link a small stylesheet now finishes its build with a tip pointing at `pracht({ inlineCss: true })`, which trades that render-blocking request for bytes repeated per document.
