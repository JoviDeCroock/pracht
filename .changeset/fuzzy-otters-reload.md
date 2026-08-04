---
"@pracht/vite-plugin": patch
---

Keep dev pages with `hydration: "islands"` or `hydration: "none"` live when CSS
content scanners register their server-only source files as watched assets.

File-only asset graph entries no longer suppress the full-page reload required
for changed server-rendered modules, while real client JavaScript and CSS
modules continue to use their existing hot-update paths.
