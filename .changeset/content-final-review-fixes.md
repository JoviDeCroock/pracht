---
"@pracht/content": patch
---

Keep configured global locale fallbacks from replacing a missing default-locale
document, reserve Pracht's complete `/_pracht` build-output namespace from
content artifacts, and reject encoded artifact paths that deployment adapters
would map to different files.
