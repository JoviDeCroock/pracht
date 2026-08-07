---
"@pracht/capabilities": minor
"@pracht/core": minor
---

Add a durable approval store for destructive capabilities.

The stateless prepare/commit flow proves a commit is bound to one principal,
one capability, and one exact input — but a captured token replays until it
expires, and the calling agent can hand its own token straight back to itself.

`setCapabilityApprovalStore()` closes both. Prepare records a proposal (keyed
by a server-derived digest of principal + capability + input, so repeated
prepares address one proposal); commit verifies the HMAC first, then consumes
the proposal exactly once. `agents.confirmation.mode: "human"` additionally
refuses the commit with `confirmation_pending` until a person approves out of
band. `createMemoryApprovalStore()` ships as the reference implementation for
tests, development, and single-instance deployments.

The wire protocol is unchanged: callers still just echo the confirmation
token. `CapabilityErrorCode` gains `confirmation_pending`, and the error
payload gains an optional `approvalId`.
