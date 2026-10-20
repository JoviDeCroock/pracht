---
"@pracht/vite-plugin": patch
---

A manifest ref written without a leading `./`, such as `features/home.tsx`, is now registered, hinted and stripped for the client like any other route module.
