---
"@pracht/core": patch
---

Reject unsafe URL schemes in client-side navigation.

`navigateToClientLocation` and the router's redirect handling now refuse to
navigate when a server-supplied `Location` header, loader redirect, or form
action response resolves to anything other than `http:` or `https:`.
`javascript:`, `data:`, `vbscript:`, `blob:`, and `file:` URLs are logged
and dropped instead of being assigned to `window.location.href`.

Prevents a server-controlled (or developer-mishandled) redirect from turning
into script execution or a phishing target in the browser.
