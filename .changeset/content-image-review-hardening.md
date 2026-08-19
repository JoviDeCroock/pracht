---
"@pracht/cli": patch
"@pracht/content": patch
"@pracht/image": patch
---

Preserve Vite resource-query imports for registered content sources, reject
non-portable artifact filenames and public-tree collisions, and publish
original SVG or animated static images discovered only by server route graphs.
Keep the static image module's named `variants` export aligned with its public
TypeScript declaration for unprocessed public assets.
