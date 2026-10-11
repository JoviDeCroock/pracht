/**
 * Text handling shared by the build-time docs index (`docs-index-build.ts`)
 * and the request-time search (`docs-index.ts`). Both sides must split and
 * stem words identically, or a query term would never meet its posting.
 */

/** Words that carry no signal in a docs query. Never indexed, never searched. */
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "about all also and any are because been but can could did does doing done for from " +
    "get gets had has have how into its just let like more most not now off one only onto " +
    "other our out over should some such than that the their them then there these they " +
    "this those through use used uses using via was way what when where which while who " +
    "why will with within without would yet you your"
  ).split(" "),
);

/** Shorter words ("is", "ui", "id") are neither indexed nor searched. */
export const MIN_WORD_LENGTH = 3;

/**
 * Reduce a lowercase word to a root shared by its common inflections, so
 * "capability" meets "capabilities" and "route" meets "routing", while "add"
 * stays apart from "additional".
 */
export function stem(word: string): string {
  let root = word;
  if (root.length > 4 && root.endsWith("ies")) root = `${root.slice(0, -3)}y`;
  else if (root.length > 4 && root.endsWith("sses")) root = root.slice(0, -2);
  else if (root.length > 4 && /(?:[xz]|ch|sh)es$/.test(root)) root = root.slice(0, -2);
  else if (root.length > 3 && root.endsWith("s") && !root.endsWith("ss")) root = root.slice(0, -1);
  if (root.length > 5 && root.endsWith("ing")) root = root.slice(0, -3);
  else if (root.length > 4 && root.endsWith("ed")) root = root.slice(0, -2);
  if (root.length > 4 && root.endsWith("e")) root = root.slice(0, -1);
  if (root.length > 4 && root.endsWith("y")) root = `${root.slice(0, -1)}i`;
  return root;
}

/**
 * The searchable stems of `text`, in order, each with the offset of the word
 * it came from. A camelCase identifier yields itself and its parts, so
 * `defineCapability` is found by "definecapability" and by "capability".
 */
export function* textStems(text: string): Generator<{ stem: string; index: number }> {
  for (const match of text.normalize("NFKC").matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    const parts = word.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u);
    const candidates = parts.length > 1 ? [word, ...parts] : [word];
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      if (lower.length < MIN_WORD_LENGTH || STOPWORDS.has(lower)) continue;
      yield { stem: stem(lower), index: match.index };
    }
  }
}

/** Markdown → readable plain text. Code stays: identifiers are what people search for. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gm, " ")
    .replace(/[`*]/g, "")
    .replace(/[>|#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
