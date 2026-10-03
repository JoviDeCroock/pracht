---
"@pracht/vite-plugin": patch
---

Keep the routes of a `group({ hydration: "islands" })` or `"none"` group out of the full client bundle when the group's options also hold an array, such as a `middleware` list.
