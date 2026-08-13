/**
 * Stable facade for Pracht's dependency-free JSON Schema subset.
 *
 * Definition diagnostics, default application, and runtime validation live in
 * focused modules so each lifecycle concern can evolve independently while
 * capabilities and external consumers keep one public entry point.
 *
 * Capabilities store plain JSON Schema so their graph stays serializable and
 * can be projected to agent surfaces without a runtime schema library. The
 * supported subset is deliberately fail-closed: unsupported or malformed
 * keywords are rejected at definition time instead of silently widening what
 * an exposed capability accepts.
 */

export {
  collectInvalidSchemaKeywordValues,
  collectUnsupportedSchemaKeywords,
} from "./schema-definition.ts";
export { applySchemaDefaults } from "./schema-defaults.ts";
export { validateAgainstSchema } from "./schema-validation.ts";
export type { CapabilityIssue, JsonSchema } from "./schema-types.ts";
