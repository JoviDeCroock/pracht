"@pracht/core": patch

Fix a client-side navigation loop when middleware redirects a protected route
back to the page the user is already viewing. Internal redirect handling now
short-circuits current-page redirects and preserves external redirects.
