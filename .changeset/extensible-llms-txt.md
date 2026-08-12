---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Extend the built-in llms.txt generator with per-page metadata and source callbacks, curated introductory Markdown, custom page sections, Markdown-suffix page assets, and an optional llms-full.txt corpus. Generated artifacts are available consistently during development and production builds, including when public files, descendant prerender paths, or companion generators collide; excluded paths skip user callbacks, output paths remain collision-free, and dynamic SSG/ISG routes remain expanded through getStaticPaths().
