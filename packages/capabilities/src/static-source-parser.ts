/** Compatibility facade for the shared static source-parsing primitives. */
export { evaluateLiteral } from "./static-literal.ts";
export {
  findMatchingBrace,
  findQuotedObjectProperty,
  findStringEnd,
  maskComments,
  maskCommentsAndStrings,
  skipInsignificant,
  skipToTopLevelComma,
} from "./static-source-lexical.ts";
