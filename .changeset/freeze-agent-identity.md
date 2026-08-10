---
"@pracht/capabilities": patch
"@pracht/core": patch
---

Protect verified Web Bot Auth identity from application-context mutation.
`context.agent` and its identity fields are now read-only immutable snapshots,
including in `createCapabilityTestHost()`. Capability hosts and audit hooks
receive immutable snapshots too, so observers and composed calls continue to
use the identity the transport actually verified.
