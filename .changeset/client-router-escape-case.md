---
"@pracht/core": patch
---

The client router and islands navigation match a route in either percent-escape case (`/caf%c3%a9` and `/caf%C3%A9`), as the server does, instead of loading the page as a full document.
