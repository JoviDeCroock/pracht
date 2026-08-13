import { normalizeStackFile } from "./editor-path.ts";
import type { StackFrame } from "./model.ts";

const FRAME_PARENS = /^\s*at\s+(?:async\s+)?.*?\((.*)\)\s*$/;
const FRAME_BARE = /^\s*at\s+(?:async\s+)?(.*?)\s*$/;
const LOCATION = /^(.*?):(\d+):(\d+)$/;

/**
 * Parse a V8-style stack trace into frames. Non-frame lines (the message
 * line, empty lines) are preserved as non-app frames without a location.
 */
export function parseStackFrames(stack: string, options: { root?: string } = {}): StackFrame[] {
  return stack.split("\n").map((line) => parseStackFrameLine(line, options.root));
}

function parseStackFrameLine(raw: string, root: string | undefined): StackFrame {
  const locationText = FRAME_PARENS.exec(raw)?.[1] ?? FRAME_BARE.exec(raw)?.[1];
  if (!locationText) return { raw, isApp: false };

  const location = LOCATION.exec(locationText);
  if (!location) {
    return { raw, locationText, isApp: !isInternalStackPath(locationText) };
  }

  const [, rawPath, line, column] = location;
  if (isInternalStackPath(rawPath)) return { raw, locationText, isApp: false };

  return {
    raw,
    locationText,
    file: normalizeStackFile(rawPath, root),
    line: Number(line),
    column: Number(column),
    isApp: true,
  };
}

function isInternalStackPath(path: string): boolean {
  return (
    path === "native" ||
    path === "<anonymous>" ||
    // Nested eval locations like `eval at foo (file:1:2), <anonymous>` are
    // not openable file paths.
    path.includes("(") ||
    path.startsWith("node:") ||
    path.startsWith("internal/") ||
    path.startsWith("virtual:") ||
    path.includes("\0") ||
    path.includes("/node_modules/") ||
    path.includes("\\node_modules\\") ||
    path.includes("/@vite/")
  );
}
