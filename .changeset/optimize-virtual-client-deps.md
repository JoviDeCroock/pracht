---
"@pracht/vite-plugin": patch
---

Pre-bundle `@pracht/core` (index, `/client`, and `/manifest` entries) in the
dev dependency optimizer when the package is installed from npm. The virtual
client entry and the plugin's own transforms import these after Vite's scanner
has run, so the first browser hit triggered a re-optimize plus full reload
that aborted in-flight module requests mid-hydration (breaking, for example,
Playwright runs against a freshly started dev server). Workspace-linked
setups (like this monorepo's examples) are left untouched — Vite treats
linked packages as source, and force-including them would split the runtime
into two copies.
