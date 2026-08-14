/**
 * Stable static-analysis entry for build tools that cannot execute application
 * modules. Domain analyzers stay conservative and share offset-preserving
 * lexical primitives so Vite, verification, typegen, and graph fallbacks agree.
 */
export {
  extractCapabilityProjection,
  extractDefineCapabilityArgs,
  type CapabilityProjection,
} from "./static-capability.ts";

export { extractCapabilityRegistrations, extractDefineAppObjectBody } from "./static-app.ts";

export {
  findTopLevelObjectProperty,
  scanTopLevelProperties,
  scanTopLevelPropertyEntries,
  type TopLevelPropertyScan,
} from "./static-object.ts";

export { evaluateLiteral } from "./static-literal.ts";
export { maskCommentsAndStrings } from "./static-source/mask.ts";
export { createCodePositionMask } from "./static-code-mask.ts";
export {
  PRACHT_PUBLIC_ENV_PREFIX,
  VITE_BUILTIN_ENV_NAMES,
  WHOLE_ENV_READ,
  scanEnvironmentReferences,
  type EnvironmentReference,
} from "./static-environment.ts";
