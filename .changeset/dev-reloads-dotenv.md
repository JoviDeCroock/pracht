---
"@pracht/cli": patch
---

`pracht dev` now reloads `.env` files when you save one, so `process.env` and `serverEnv` pick up the change without restarting the command.
