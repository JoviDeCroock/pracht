---
"@pracht/core": minor
"@pracht/vite-plugin": minor
---

Every document served by `pracht dev` now registers dev-only, read-only WebMCP page tools (`pracht_route`, `pracht_loader_data`, `pracht_islands`, `pracht_last_error`, `pracht_page_tools`) so an agent-driven browser can ask the open tab which route matched, what its loader returned, which islands hydrated, and what the last error was. Nothing is emitted in a production build, and `pracht({ devPageTools: false })` turns them off.
