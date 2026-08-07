---
"@pracht/core": minor
"@pracht/cli": minor
---

Extend `pracht plan` and `pracht report` to the agent-facing surface.

The app-graph snapshot (`.pracht/app-graph.json`) now records registered
capabilities, so a change that widens what agents can reach finally produces a
diff. Previously the snapshot held only routes, API endpoints, and constraints
— adding `expose: { mcp: true }`, downgrading `agentPolicy` from `require`,
dropping a capability's auth middleware, reclassifying a `destructive`
capability out of the confirmation flow, or loosening an input schema all
showed up as nothing at all.

Capability lines are marked `!` when they widen the agent-reachable surface,
`--markdown` puts a callout above the diff, and `GraphDiff` gains
`capabilityChanges` and `widensAgentSurface`. Input-schema widenings are
detected structurally: dropped `required` fields, opened
`additionalProperties`, widened enums, and raised or removed bounds, including
nested ones (`input.limit: maximum raised (50 → 5000)`). Narrowings stay quiet.

`AppGraphCapability` gains `agentPolicy`, which `pracht inspect capabilities`
did not previously surface.

Snapshots committed before this release have no capabilities recorded, so the
first `pracht plan` after upgrading reports them as added; `pracht plan
--write` settles it.
