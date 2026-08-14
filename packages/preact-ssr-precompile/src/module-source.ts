/** Shared module-id and lightweight source classification used before parsing. */

export function stripQuery(id: string): string {
  return id.split("?", 1)[0];
}

// Cheap heuristic to skip parsing files that obviously contain no JSX. May
// produce false positives (e.g. `f(x<Y)` in TypeScript generics or comparisons);
// those fall through to the transform parser, which either re-parses as TSX or bails.
export function looksLikeJSX(code: string): boolean {
  return /<>|<\/[A-Za-z]|<[A-Za-z]/.test(code);
}
