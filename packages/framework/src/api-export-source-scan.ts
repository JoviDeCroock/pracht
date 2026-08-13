/** Stable facade for conservative source-only API export analysis. */

export { hasStaticallyCallableDefaultExport } from "./api-export-callable-source.ts";
export {
  findTopLevelOffsets,
  hasTopLevelMatch,
  maskJavaScriptCommentsAndStrings,
  readStringLiteral,
} from "./api-export-source-lexical.ts";
