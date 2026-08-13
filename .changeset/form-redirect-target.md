---
"@pracht/core": patch
---

Fix `<Form>` navigating to the API route instead of the page a redirect
pointed at.

A hydrated `<Form method="post" action="/api/...">` submitted with
`redirect: "manual"`, so a same-origin 3xx came back opaque-filtered — status
`0`, no readable `Location` — and the client fell back to the action URL.
Visitors landed on the API route itself (a GET, typically `405 Method Not
Allowed`) instead of the redirect target, which is the documented shape for
login forms and any other API route that redirects back after a mutation.
Submissions now opt into the same readable redirect handshake
`<Form capability>` already used. API dispatch returns the target without
fetching it first, then the client performs exactly one navigation. This also
keeps cross-origin login and SSO targets out of the form submission's CORS
fetch.
