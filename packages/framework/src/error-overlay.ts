/**
 * Public dev error-overlay entry point.
 *
 * Keep this module as the self-contained package facade while stack parsing,
 * editor path resolution, and HTML rendering evolve independently.
 */
export { normalizeStackFile } from "./error-overlay/editor-path.ts";
export type { ErrorOverlayOptions, StackFrame } from "./error-overlay/model.ts";
export { buildErrorOverlayHtml } from "./error-overlay/render.ts";
export { parseStackFrames } from "./error-overlay/stack.ts";
