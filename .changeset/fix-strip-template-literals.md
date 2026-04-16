---
"@pracht/vite-plugin": patch
---

Fix the client-module transform so it no longer matches `export` / `import` patterns inside string or template literals. Previously, source containing code-block strings (e.g. documentation pages embedding `export async function loader` inside a `` `` template) had those fragments stripped, breaking the surrounding string and producing "Unterminated string" build errors.
