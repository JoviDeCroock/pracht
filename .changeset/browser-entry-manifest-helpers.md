---
"@pracht/core": patch
---

Export the manifest and agent-trust helpers from the entries that actually
receive them.

`defineApp({ constraints })` is documented in `docs/AGENT_WORKFLOW.md`, but
`requireMiddleware`, `requireShell`, `requireRenderMode`, `forbidRenderMode` and
`requireHead` were only exported from `@pracht/core`. The Vite plugin rewrites
the app manifest's `@pracht/core` import to the browser entry and bundles the
manifest into the client, so declaring a single constraint made the manifest
fail to link in the browser — and because the failure happens while the client
entry is loading, the whole app silently stopped hydrating with no visible
error. `webhookRevalidate()` had the same gap.

The agent-trust registration SPIs move the other way: `setCapabilityAuditHook`,
`setCapabilityConfirmationSecret`, `setCapabilityApprovalStore`,
`setCapabilityApprovalPrincipalResolver`, `createMemoryApprovalStore`,
`verifyAgentSignature` and the `CONFIRMATION_*` constants are now also exported
from `@pracht/core/server`. They are server-only, and an edge SSR build resolves
`@pracht/core` through the `browser` condition, so importing them from the
package root — as `docs/AGENT_TRUST.md` showed — failed the build with a missing
export. Both entries keep their existing exports; nothing is removed.
