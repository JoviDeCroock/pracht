/**
 * GitHub-flavoured heading slug: strip tags, lowercase, drop everything that is
 * not alphanumeric, a space, or a hyphen, then join on hyphens. The docs
 * cross-link each other by `#anchor`, and marked stopped emitting heading ids
 * in v13, so without this every one of those links scrolls nowhere.
 *
 * `pracht docs` (packages/cli/src/docs.ts `headingAnchor`) must produce the
 * same ids from Markdown; `test/cli-docs-anchors.test.ts` holds them together.
 */
export function slugify(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/ /g, "-");
}
