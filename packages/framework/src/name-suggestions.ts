/**
 * "Did you mean" helpers for manifest wiring errors. The implementation lives
 * in `@pracht/capabilities/server` (the capability core uses it for unknown
 * capability/middleware names); re-exported here for the framework's own
 * shell/middleware/route wiring errors.
 */

export {
  closestName,
  formatUnknownNameError,
  levenshteinDistance,
  type UnknownNameErrorOptions,
} from "@pracht/capabilities/server";
