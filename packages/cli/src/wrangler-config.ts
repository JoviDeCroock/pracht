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

/** What a wrangler config says about its assets binding's `html_handling`. */
export interface WranglerAssetsHtmlHandling {
  /** `undefined` when the key is absent, i.e. wrangler's `auto-trailing-slash`. */
  htmlHandling: string | undefined;
}

export interface WranglerBundleSettings {
  /** `null` for the default deployment, otherwise the named Wrangler environment. */
  environment: string | null;
  /** `undefined` when Wrangler's default bundling remains active. */
  noBundle: boolean | undefined;
  /** Whether a module rule preserves Vite's emitted JavaScript chunks as ESM. */
  hasJavaScriptModuleRule: boolean;
}

/**
 * The effective settings that preserve Vite's server chunks for the default
 * deployment and every named environment that overrides them, or `null` when
 * the file cannot be parsed conservatively. `no_bundle` prevents Wrangler
 * from folding the chunks into its entry, while the ESModule rule makes
 * Wrangler upload the `.js` files next to that entry.
 */
export function readWranglerBundleSettings(configFile: string): WranglerBundleSettings[] | null {
  let source: string;
  try {
    source = readFileSync(configFile, "utf-8");
  } catch {
    return null;
  }

  if (configFile.endsWith(".toml")) {
    interface TomlBundleScope {
      hasNoBundleOverride: boolean;
      hasRulesOverride: boolean;
      hasJavaScriptModuleRule: boolean;
      noBundle: boolean | undefined;
    }
    const createScope = (): TomlBundleScope => ({
      hasNoBundleOverride: false,
      hasRulesOverride: false,
      hasJavaScriptModuleRule: false,
      noBundle: undefined,
    });
    const root = createScope();
    const environments = new Map<string, TomlBundleScope>();
    const environmentScope = (name: string) => {
      const scope = environments.get(name) ?? createScope();
      environments.set(name, scope);
      return scope;
    };
    let settingsScope: TomlBundleScope | undefined = root;
    let ruleScope: TomlBundleScope | undefined;
    let ruleType: string | undefined;
    let ruleGlobs: string[] = [];
    const finishRule = () => {
      if (ruleScope && ruleType === "ESModule" && ruleGlobs.includes("**/*.js")) {
        ruleScope.hasJavaScriptModuleRule = true;
      }
      ruleScope = undefined;
      ruleType = undefined;
      ruleGlobs = [];
    };
    for (const line of source.split(/\r?\n/)) {
      const tableMatch = TOML_TABLE_RE.exec(line);
      if (tableMatch) {
        finishRule();
        settingsScope = undefined;
        const table = tableMatch[1]!;
        if (table === "rules") {
          root.hasRulesOverride = true;
          ruleScope = root;
          continue;
        }
        const environment = /^env\s*\.\s*([^.\s]+)$/.exec(table)?.[1];
        if (environment) {
          settingsScope = environmentScope(environment);
          continue;
        }
        const environmentRules = /^env\s*\.\s*([^.\s]+)\s*\.\s*rules$/.exec(table)?.[1];
        if (environmentRules) {
          ruleScope = environmentScope(environmentRules);
          ruleScope.hasRulesOverride = true;
        }
        continue;
      }
      if (settingsScope) {
        const match = /^\s*no_bundle\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line);
        if (match) {
          settingsScope.hasNoBundleOverride = true;
          settingsScope.noBundle = match[1] === "true";
          continue;
        }
        // Inline rule tables are outside this deliberately small parser. Mark
        // the scope as an override so callers warn instead of inheriting a
        // top-level rule that Wrangler will replace.
        if (/^\s*rules\s*=/.test(line)) settingsScope.hasRulesOverride = true;
      }
      if (!ruleScope) {
        const dotted =
          /^\s*env\s*\.\s*([^.\s]+)\s*\.\s*no_bundle\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line);
        if (dotted) {
          const scope = environmentScope(dotted[1]!);
          scope.hasNoBundleOverride = true;
          scope.noBundle = dotted[2] === "true";
        }
        continue;
      }
      const typeMatch = new RegExp(String.raw`^\s*type\s*=\s*${TOML_VALUE}\s*(?:#.*)?$`).exec(line);
      if (typeMatch) {
        ruleType = typeMatch[1] ?? typeMatch[2]!;
        continue;
      }
      const globsMatch = /^\s*globs\s*=\s*\[(.*)\]\s*(?:#.*)?$/.exec(line);
      if (globsMatch) ruleGlobs = readTomlStringArray(globsMatch[1]!);
    }
    finishRule();
    return [
      {
        environment: null,
        noBundle: root.noBundle,
        hasJavaScriptModuleRule: root.hasJavaScriptModuleRule,
      },
      ...[...environments.entries()]
        .filter(([, scope]) => scope.hasNoBundleOverride || scope.hasRulesOverride)
        .map(([environment, scope]) => ({
          environment,
          noBundle: scope.hasNoBundleOverride ? scope.noBundle : root.noBundle,
          hasJavaScriptModuleRule: scope.hasRulesOverride
            ? scope.hasJavaScriptModuleRule
            : root.hasJavaScriptModuleRule,
        })),
    ];
  }

  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(source).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
  if (!config || typeof config !== "object") return null;

  const root = config as Record<string, unknown>;
  const value = root.no_bundle;
  const rules = root.rules;
  const hasJavaScriptModuleRule = (candidateRules: unknown) =>
    Array.isArray(candidateRules) &&
    candidateRules.some((rule) => {
      if (!rule || typeof rule !== "object") return false;
      const candidate = rule as Record<string, unknown>;
      return (
        candidate.type === "ESModule" &&
        Array.isArray(candidate.globs) &&
        candidate.globs.includes("**/*.js")
      );
    });
  const settings: WranglerBundleSettings[] = [
    {
      environment: null,
      noBundle: typeof value === "boolean" ? value : undefined,
      hasJavaScriptModuleRule: hasJavaScriptModuleRule(rules),
    },
  ];
  const environments = root.env;
  if (environments && typeof environments === "object") {
    for (const [environment, entry] of Object.entries(environments as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Record<string, unknown>;
      if (!Object.hasOwn(candidate, "no_bundle") && !Object.hasOwn(candidate, "rules")) continue;
      const environmentNoBundle = candidate.no_bundle;
      settings.push({
        environment,
        noBundle: Object.hasOwn(candidate, "no_bundle")
          ? typeof environmentNoBundle === "boolean"
            ? environmentNoBundle
            : undefined
          : typeof value === "boolean"
            ? value
            : undefined,
        hasJavaScriptModuleRule: hasJavaScriptModuleRule(
          Object.hasOwn(candidate, "rules") ? candidate.rules : rules,
        ),
      });
    }
  }
  return settings;
}

function readTomlStringArray(source: string): string[] {
  const values: string[] = [];
  const valuePattern = /"([^"]*)"|'([^']*)'/g;
  for (const match of source.matchAll(valuePattern)) values.push(match[1] ?? match[2]!);
  return values;
}

/**
 * The top-level `assets.html_handling` value, or `null` when it cannot be
 * proven — an unreadable file, a parse failure, a TOML config (not parsed
 * here), or no `assets` block at all.
 *
 * `null` means "unknown", never "fine": callers must stay silent on it rather
 * than reporting a config they could not read.
 */
export function readWranglerAssetsHtmlHandling(
  configFile: string,
): WranglerAssetsHtmlHandling | null {
  if (configFile.endsWith(".toml")) return null;

  let source: string;
  try {
    source = readFileSync(configFile, "utf-8");
  } catch {
    return null;
  }

  let config: unknown;
  try {
    config = JSON.parse(stripJsonComments(source).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
  if (!config || typeof config !== "object") return null;

  const assets = (config as Record<string, unknown>).assets;
  if (!assets || typeof assets !== "object") return null;

  const htmlHandling = (assets as Record<string, unknown>).html_handling;
  return { htmlHandling: typeof htmlHandling === "string" ? htmlHandling : undefined };
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

// Enough TOML for the deployment keys these readers inspect. Deliberately
// conservative: a shape this does not recognize yields no entry, and callers
// must treat "no entries" as "unknown" rather than "fine" — see
// collectCloudflareEntryCheck.
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
