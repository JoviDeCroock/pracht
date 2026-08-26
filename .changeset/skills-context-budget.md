---
"create-pracht": patch
---

Tighten the seeded skill catalog for context efficiency: descriptions are 25%
smaller and the largest skill bodies 8-25% smaller.

Every skill's `description` sits in the agent's system prompt for the whole
session whether or not the skill runs, so the catalog was a ~3.5k-token
standing tax on every scaffolded app. Descriptions are now one sentence of what
the skill does plus its trigger phrases, and the biggest bodies (`/migrate-nextjs`,
`/pracht-deploy`, `/pracht-debug`, `/pracht-scaffold`, `/add-db`, `/add-auth`,
`/pre-deploy`, `/add-i18n`) drop duplicated preambles and trailing rule recaps.
No skill loses a directive or a check. CI now enforces per-skill and
catalog-wide budgets so the prose cannot creep back.
