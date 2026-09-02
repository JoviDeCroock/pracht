---
"@pracht/cli": minor
---

Add `pracht skills list` and `pracht skills add <name...>`, which browse the published skill catalog and install skills into `.claude/skills/`. The index is treated as untrusted: every entry must carry a SHA-256 that the downloaded body is checked against, the index and skill URLs must use https, and a name that would resolve outside `.claude/skills/` is refused.
