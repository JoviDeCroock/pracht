---
"@pracht/capabilities": minor
"@pracht/core": minor
---

Add a durable approval store for destructive capabilities.

The stateless prepare/commit flow proves a commit is bound to one principal,
one capability, and one exact input — but a captured token replays until it
expires, and the calling agent can hand its own token straight back to itself.

`setCapabilityApprovalStore()` closes the replay gap. Prepare records a
proposal (keyed by a secret-derived digest of principal + capability + input +
approval mode, so repeated prepares address one proposal without exposing
low-entropy principals); commit verifies the HMAC first, then consumes the
proposal exactly once. Store-backed tokens use a distinct version and bind the
approval mode, so rolling deployments fail closed on older or differently
configured replicas. `agents.confirmation.mode: "human"` also closes the
self-approval gap by refusing the commit with `confirmation_pending` until a
person approves out of band.
`setCapabilityApprovalPrincipalResolver()` binds proposals to an
application-authenticated user or tenant; human mode fails closed without that
identity or a verified Web Bot Auth agent. `createMemoryApprovalStore()` ships
as the reference implementation for tests, development, and single-instance
deployments. Durable implementations must atomically insert proposals and
compare-and-set consumption so concurrent prepares cannot resurrect a commit;
consumed and rejected proposals stay closed until their TTL expires.

The caller interaction is unchanged: callers still just echo the confirmation
token. `CapabilityErrorCode` gains `confirmation_pending`, and the error
payload gains an optional `approvalId`.
