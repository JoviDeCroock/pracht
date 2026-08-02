---
"@pracht/core": patch
---

Run app-level API middleware around generated capability HTTP endpoints before
capability-specific middleware and request parsing, so centralized API
authentication and authorization policies cannot be bypassed.
