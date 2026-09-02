---
"@pracht/core": patch
---

Rendering a plain `<Form action=…>` no longer pulls the capability revalidation runtime into the page's entry chunk, and an islands page drops it entirely when the build proves the app registers no capabilities.
