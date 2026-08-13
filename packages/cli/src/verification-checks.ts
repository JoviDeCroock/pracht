/** Stable facade for CLI project verification checks. */

export { collectApiVerification } from "./verification-api-checks.js";
export { exportsMiddleware } from "./middleware-export-source.js";
export {
  collectConfigChecks,
  collectManifestVerification,
} from "./verification-manifest-checks.js";
export { collectPagesVerification } from "./verification-page-checks.js";
export { collectBudgetChecks, collectPackageChecks } from "./verification-project-checks.js";
