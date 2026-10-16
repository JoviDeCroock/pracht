import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Wrangler's own lookup order: `wrangler.json` wins over `wrangler.jsonc`. */
const WRANGLER_CONFIG_FILES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];

/**
 * Node.js builtins workerd provides for the Worker's compatibility flags.
 * `nodejs_compat` covers far more modules than this, but which ones depends on
 * the compatibility date; only `node:async_hooks` is known for every date that
 * either flag accepts, and it is the one Worker libraries (request-scoped
 * `AsyncLocalStorage`) actually need. Unknown or unreadable config allows none.
 */
export function cloudflareEdgeNodeBuiltins(root: string, configPath?: string): string[] {
  const flags = readCompatibilityFlags(root, configPath);
  return flags.includes("nodejs_als") || flags.includes("nodejs_compat")
    ? ["node:async_hooks"]
    : [];
}

function readCompatibilityFlags(root: string, configPath?: string): string[] {
  const file = configPath
    ? resolve(root, configPath)
    : WRANGLER_CONFIG_FILES.map((name) => resolve(root, name)).find((candidate) =>
        existsSync(candidate),
      );
  if (!file || file.endsWith(".toml")) return [];

  let config: unknown;
  try {
    config = JSON.parse(
      stripJsonComments(readFileSync(file, "utf-8")).replace(/,(\s*[}\]])/g, "$1"),
    );
  } catch {
    return [];
  }
  const flags = (config as { compatibility_flags?: unknown } | null)?.compatibility_flags;
  return Array.isArray(flags) ? flags.filter((flag) => typeof flag === "string") : [];
}

/** Removes `//` and block comments without touching comment-like text inside strings. */
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    const next = source[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      out += char;
    }
  }

  return out;
}
