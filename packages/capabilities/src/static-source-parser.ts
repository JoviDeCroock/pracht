/** Compatibility facade for the shared static source-parsing primitives. */
export { evaluateLiteral } from "./static-literal.ts";
export { maskComments, maskCommentsAndStrings } from "./static-source/mask.ts";
export {
  findMatchingBrace,
  findQuotedObjectProperty,
  skipInsignificant,
  skipToTopLevelComma,
} from "./static-source/scan.ts";
export { findStringEnd } from "./static-source/strings.ts";
