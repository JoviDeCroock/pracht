---
"@pracht/vite-plugin": patch
---

The browser entry carries one compact hint per route module instead of three tables with two keys each, so apps with many routes ship a smaller client entry (about 3.6 KB gzip less at 500 routes).
