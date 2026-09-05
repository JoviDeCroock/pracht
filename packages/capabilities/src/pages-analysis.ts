/** Pages-router conventions shared by manifest generation and verification. */
export const PAGES_APP_CONFIG_EXPORTS = ["agents", "constraints"] as const;

export function pagesShellName(directory: string): string {
  return directory === "" ? "pages" : `pages:${directory}`;
}

/** The `_app` that owns a page: the nearest ancestor directory with one. */
export function findOwningPagesShell<T extends { directory: string }>(
  shells: readonly T[],
  pageRelativePath: string,
): T | undefined {
  const segments = pageRelativePath.replace(/\\/g, "/").split("/").slice(0, -1);
  let owner: T | undefined;
  for (const shell of shells) {
    const ownsPage =
      shell.directory === "" ||
      segments.slice(0, shell.directory.split("/").length).join("/") === shell.directory;
    if (ownsPage && (!owner || shell.directory.length > owner.directory.length)) owner = shell;
  }
  return owner;
}

/** Mask Markdown fenced examples while preserving source offsets and top-level MDX exports. */
export function maskMarkdownFences(source: string, relativePath: string): string {
  if (!/\.mdx?$/.test(relativePath)) return source;

  const chars = source.split("");
  let activeFence: { character: "`" | "~"; continuationIndent: number; length: number } | null =
    null;
  for (const line of source.matchAll(/.*(?:\r?\n|$)/g)) {
    if (line[0] === "") continue;
    const lineStart = line.index ?? 0;
    const content = line[0].replace(/\r?\n$/, "");
    const stripped = stripMarkdownContainerPrefix(content);
    const fenceContent: string =
      activeFence && stripped.content.startsWith(" ".repeat(activeFence.continuationIndent))
        ? stripped.content.slice(activeFence.continuationIndent)
        : stripped.content;
    const opening: RegExpExecArray | null = activeFence
      ? null
      : /^ {0,3}(`{3,}|~{3,})/.exec(fenceContent);
    const closing = activeFence
      ? new RegExp(`^ {0,3}\\${activeFence.character}{${activeFence.length},}[ \\t]*$`).test(
          fenceContent,
        )
      : false;

    if (activeFence || opening) {
      for (let offset = 0; offset < line[0].length; offset += 1) {
        const index = lineStart + offset;
        if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
      }
    }

    if (closing) {
      activeFence = null;
    } else if (opening) {
      activeFence = {
        character: opening[1][0] as "`" | "~",
        continuationIndent: stripped.continuationIndent,
        length: opening[1].length,
      };
    }
  }
  return chars.join("");
}

function stripMarkdownContainerPrefix(line: string): {
  content: string;
  continuationIndent: number;
} {
  let content = line;
  let continuationIndent = 0;
  while (true) {
    const quote = /^ {0,3}> ?/.exec(content);
    if (quote) {
      content = content.slice(quote[0].length);
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(content);
    if (!list) return { content, continuationIndent };
    continuationIndent += list[0].length;
    content = content.slice(list[0].length);
  }
}
