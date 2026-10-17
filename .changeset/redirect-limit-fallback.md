---
"@pracht/core": patch
---

A client navigation that exceeds twenty redirects now continues as a full page load, so the browser follows the rest of the chain or shows its own "too many redirects" error instead of leaving the previous page on screen.
