---
"@pracht/core": minor
"@pracht/vite-plugin": minor
---

llms.txt now includes a `## Capabilities` section listing every HTTP-exposed capability with its dispatch endpoint, effect class (destructive ones note the confirmation requirement), and description, so agents discovering a site through llms.txt also find its callable operations. The section is on by default and can be excluded via `llmsTxt: { include: [...] }`.
