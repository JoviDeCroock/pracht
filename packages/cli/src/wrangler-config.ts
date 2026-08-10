import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Wrangler's own lookup order (`wrangler.json` wins over `wrangler.jsonc`,
 * which wins over `wrangler.toml`). Anything that reasons about "the config
 * wrangler will load" has to agree with this exactly, or it reports on a file
 * the deploy never reads.
 */
export const WRANGLER_CONFIG_FILES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"];

export function findWranglerConfig(root: string): string | null {
  for (const name of WRANGLER_CONFIG_FILES) {
    const candidate = resolve(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A `main` entry with the environment it belongs to (`null` = top level). */
export interface WranglerMainEntry {
  environment: string | null;
  main: string;
}

/**
 * Every `main` a wrangler config declares: the top-level one plus each
 * `env.<name>.main` override, since `main` is inheritable per environment and
 * `wrangler deploy --env <name>` ships the override.
 *
 * Returns an empty array when the file cannot be read or parsed — callers
 * report on what they can prove, never on a guess.
 */
export function readWranglerMainEntries(configFile: string): WranglerMainEntry[] {
  let source: string;
  try {
    source = readFileSync(configFile, "utf-8");
  } catch {
    return [];
  }

  return configFile.endsWith(".toml") ? readTomlMainEntries(source) : readJsonMainEntries(source);
}

function readJsonMainEntries(source: string): WranglerMainEntry[] {
  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(source).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return [];
  }
  if (!config || typeof config !== "object") return [];

  const entries: WranglerMainEntry[] = [];
  const root = config as Record<string, unknown>;
  if (typeof root.main === "string") {
    entries.push({ environment: null, main: root.main });
  }

  const env = root.env;
  if (env && typeof env === "object") {
    for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
      if (value && typeof value === "object") {
        const main = (value as Record<string, unknown>).main;
        if (typeof main === "string") entries.push({ environment: name, main });
      }
    }
  }

  return entries;
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
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    out += char;
  }

  return out;
}

// Enough TOML for the one key this reads. Deliberately conservative: a shape
// this does not recognize yields no entry, and callers must treat "no entries"
// as "unknown" rather than "fine" — see collectCloudflareEntryCheck.
//
// `[table]` and `[[array.of.tables]]` headers, both of which may carry a
// trailing comment. Missing a header would attribute the keys under it to the
// wrong scope, so the array form matters even though it never holds `main`.
const TOML_TABLE_RE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const TOML_VALUE = String.raw`(?:"([^"]*)"|'([^']*)')`;
const TOML_MAIN_RE = new RegExp(String.raw`^\s*main\s*=\s*${TOML_VALUE}\s*(?:#.*)?$`);
// A dotted key at the top level: `env.production.main = "..."`.
const TOML_DOTTED_ENV_MAIN_RE = new RegExp(
  String.raw`^\s*env\s*\.\s*([^.\s]+)\s*\.\s*main\s*=\s*${TOML_VALUE}\s*(?:#.*)?$`,
);

function readTomlMainEntries(source: string): WranglerMainEntry[] {
  const entries: WranglerMainEntry[] = [];
  let table: string | null = null;

  for (const line of source.split(/\r?\n/)) {
    const tableMatch = TOML_TABLE_RE.exec(line);
    if (tableMatch) {
      table = tableMatch[1]!;
      continue;
    }

    if (table === null) {
      const dotted = TOML_DOTTED_ENV_MAIN_RE.exec(line);
      if (dotted) {
        entries.push({ environment: dotted[1]!, main: dotted[2] ?? dotted[3]! });
        continue;
      }
    }

    const mainMatch = TOML_MAIN_RE.exec(line);
    if (!mainMatch) continue;
    const main = mainMatch[1] ?? mainMatch[2]!;

    if (table === null) {
      entries.push({ environment: null, main });
      continue;
    }
    // `[env.production]` — anything deeper (`[env.x.vars]`, `[build]`) is not a
    // deployable entry point and is ignored.
    const envMatch = /^env\s*\.\s*([^.\s]+)$/.exec(table);
    if (envMatch) entries.push({ environment: envMatch[1]!, main });
  }

  return entries;
}
