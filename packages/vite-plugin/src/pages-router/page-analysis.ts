import { maskCommentsAndStrings } from "@pracht/capabilities/static";
import { detectLoaderExport } from "../route-loader-hints.ts";
import type { ScannedPage } from "./model.ts";

type PageModuleAnalysis = Pick<
  ScannedPage,
  "renderMode" | "hydrationMode" | "revalidateSeconds" | "hasRevalidateExport" | "hasLoader"
>;

export function analyzePageModule(source: string, relativePath: string): PageModuleAnalysis {
  const analysisSource = maskMarkdownFences(source, relativePath);
  const revalidate = extractRevalidateSeconds(analysisSource, relativePath);

  return {
    renderMode: extractQuotedPageExport(analysisSource, "RENDER_MODE", relativePath),
    hydrationMode: extractQuotedPageExport(analysisSource, "HYDRATION", relativePath),
    revalidateSeconds: revalidate.seconds,
    hasRevalidateExport: revalidate.present,
    hasLoader: detectLoaderExport(analysisSource),
  };
}

function extractQuotedPageExport(
  source: string,
  name: "RENDER_MODE" | "HYDRATION",
  relativePath: string,
): string | undefined {
  const masked = maskCommentsAndStrings(source);
  const declarations = [...masked.matchAll(new RegExp(`export\\s+const\\s+${name}\\s*=`, "g"))];
  if (declarations.length === 0) return undefined;
  if (declarations.length > 1) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} exports ${name} more than once.`,
    );
  }

  const declaration = declarations[0];
  const valueStart = (declaration.index ?? 0) + declaration[0].length;
  return source
    .slice(valueStart)
    .trimStart()
    .match(/^["'](\w+)["']/)?.[1];
}

const REVALIDATE_RE = /export\s+const\s+REVALIDATE\s*=\s*([^;\n]+)/;

function extractRevalidateSeconds(
  source: string,
  relativePath: string,
): { present: boolean; seconds?: number } {
  const matches = [...maskCommentsAndStrings(source).matchAll(new RegExp(REVALIDATE_RE, "g"))];
  if (matches.length === 0) return { present: false };
  if (matches.length > 1) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} exports REVALIDATE more than once.`,
    );
  }

  const expression = matches[0][1].trim().replace(/\s+as\s+const$/, "");
  if (!/^\d(?:_?\d)*$/.test(expression)) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} must export REVALIDATE as a ` +
        "positive integer literal number of seconds (for example, `export const REVALIDATE = 60`).",
    );
  }

  const seconds = Number(expression.replaceAll("_", ""));
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} must export REVALIDATE as a ` +
        "positive integer literal number of seconds within JavaScript's safe integer range.",
    );
  }

  return { present: true, seconds };
}

/** Mask Markdown fenced examples while preserving source offsets and top-level MDX exports. */
function maskMarkdownFences(source: string, relativePath: string): string {
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
    const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \\t]+/.exec(content);
    if (!list) return { content, continuationIndent };
    continuationIndent += list[0].length;
    content = content.slice(list[0].length);
  }
}
