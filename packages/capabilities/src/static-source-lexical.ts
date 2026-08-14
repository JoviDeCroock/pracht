/** Compatibility facade for offset-preserving JavaScript lexical scanning. */

export { maskComments, maskCommentsAndStrings } from "./static-source/mask.ts";
export {
  findMatchingBrace,
  findQuotedObjectProperty,
  skipInsignificant,
  skipToTopLevelComma,
} from "./static-source/scan.ts";
export { findStringEnd } from "./static-source/strings.ts";
