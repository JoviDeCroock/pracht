import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Wrangler's own lookup order: `wrangler.json` wins over `wrangler.jsonc`. */
const WRANGLER_CONFIG_FILES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];

/** The compatibility date from which `nodejs_compat` means Node.js compat v2. */
const NODE_COMPAT_V2_DATE = "2024-09-23";

/**
 * Node.js builtins workerd provides for the Worker's compatibility settings,
 * or `true` for all of them. Under Node.js compat v2 the Cloudflare Vite
 * plugin resolves every builtin itself, to workerd's native module or to a
 * polyfill, so any builtin left in the bundle is one workerd serves.
 * `nodejs_als` alone provides only `node:async_hooks`. Unknown or unreadable
 * config allows none.
 */
export function cloudflareEdgeNodeBuiltins(root: string, configPath?: string): string[] | true {
  const config = readCompatibilityConfig(root, configPath);
  if (!config) return [];
  const { flags, date } = config;
  const compat = flags.includes("nodejs_compat");
  if (
    flags.includes("nodejs_compat_v2") ||
    (compat && date >= NODE_COMPAT_V2_DATE && !flags.includes("no_nodejs_compat_v2"))
  ) {
    return true;
  }
  return compat || flags.includes("nodejs_als") ? ["node:async_hooks"] : [];
}

function readCompatibilityConfig(
  root: string,
  configPath?: string,
): { flags: string[]; date: string } | undefined {
  const file = configPath
    ? resolve(root, configPath)
    : WRANGLER_CONFIG_FILES.map((name) => resolve(root, name)).find((candidate) =>
        existsSync(candidate),
      );
  if (!file || file.endsWith(".toml")) return undefined;

  let config: unknown;
  try {
    config = JSON.parse(
      stripJsonComments(readFileSync(file, "utf-8")).replace(/,(\s*[}\]])/g, "$1"),
    );
  } catch {
    return undefined;
  }
  const { compatibility_flags: flags, compatibility_date: date } = (config ?? {}) as {
    compatibility_flags?: unknown;
    compatibility_date?: unknown;
  };
  return {
    flags: Array.isArray(flags) ? flags.filter((flag) => typeof flag === "string") : [],
    // Wrangler's own default when the date is missing.
    date: typeof date === "string" ? date : "2000-01-01",
  };
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
