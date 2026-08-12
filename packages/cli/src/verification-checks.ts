import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { maskCommentsAndStrings } from "@pracht/capabilities/static";

import { extractRegistryEntries, extractRelativeModulePaths } from "./manifest.js";
import { displayPath, resolveProjectPath, type ProjectConfig } from "./project.js";
import {
  createCheck,
  isWithinDirectory,
  MODULE_SOURCE_RE,
  normalizePath,
  toModuleSpecifier,
  type Check,
} from "./verification-helpers.js";
import { collectMarkdownTransformCheck } from "./verification-page-checks.js";

export { collectApiVerification } from "./verification-api-checks.js";
export { collectBudgetChecks, collectPackageChecks } from "./verification-project-checks.js";
export { collectPagesVerification } from "./verification-page-checks.js";

export function collectConfigChecks(
  project: ProjectConfig,
  checks: Check[],
  configDisplayPath: string,
): void {
  if (!project.configFile) {
    checks.push(createCheck("error", "Missing vite config."));
  } else {
    checks.push(createCheck("ok", `Found ${configDisplayPath}.`));
  }

  if (!project.hasPrachtPlugin) {
    checks.push(createCheck("error", "vite.config does not appear to register the pracht plugin."));
  } else {
    checks.push(createCheck("ok", "Vite config registers the pracht plugin."));
  }
}

export function collectManifestVerification(
  project: ProjectConfig,
  checks: Check[],
  { changedFiles, scope }: { changedFiles: string[]; scope: string },
): void {
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) {
    checks.push(createCheck("error", `App manifest is missing at ${project.appFile}.`));
    return;
  }

  const source = readFileSync(manifestPath, "utf-8");
  const relativeModules = [...extractRelativeModulePaths(source)];
  const routeCount = (source.match(/\broute\s*\(/g) ?? []).length;

  if (scope === "full") {
    checks.push(createCheck("ok", `Found app manifest at ${project.appFile}.`));

    if (routeCount === 0) {
      checks.push(createCheck("warning", "No routes were found in the app manifest."));
    } else {
      checks.push(
        createCheck(
          "ok",
          `App manifest defines ${routeCount} route${routeCount === 1 ? "" : "s"}.`,
        ),
      );
    }

    const shellEntries = extractRegistryEntries(source, "shells");
    const middlewareEntries = extractRegistryEntries(source, "middleware");

    if (shellEntries.length > 0) {
      checks.push(
        createCheck(
          "ok",
          `Registered ${shellEntries.length} shell${shellEntries.length === 1 ? "" : "s"}.`,
        ),
      );
    }

    if (middlewareEntries.length > 0) {
      checks.push(
        createCheck(
          "ok",
          `Registered ${middlewareEntries.length} middleware module${middlewareEntries.length === 1 ? "" : "s"}.`,
        ),
      );
      collectMiddlewareExportChecks(checks, manifestPath, middlewareEntries);
    }

    const missingModules = relativeModules
      .map((modulePath) => ({
        display: modulePath,
        exists: existsSync(resolve(dirname(manifestPath), modulePath)),
      }))
      .filter((entry) => !entry.exists)
      .map((entry) => entry.display);

    if (missingModules.length > 0) {
      checks.push(
        createCheck(
          "error",
          `Manifest references missing files: ${missingModules.map((item) => JSON.stringify(item)).join(", ")}.`,
        ),
      );
    } else {
      checks.push(
        createCheck(
          "ok",
          `All ${relativeModules.length} manifest module path${relativeModules.length === 1 ? "" : "s"} resolve.`,
        ),
      );
    }
  } else {
    collectChangedManifestModuleChecks(
      project,
      checks,
      manifestPath,
      relativeModules,
      changedFiles,
    );
  }

  // `.md` / `.mdx` are valid manifest route modules and break exactly the same
  // way a pages-router Markdown page does.
  collectMarkdownTransformCheck(
    project,
    checks,
    relativeModules.map((modulePath) => resolve(dirname(manifestPath), modulePath)),
  );
}

/**
 * Whether `source` exports a binding *named* `middleware`.
 *
 * Comments and string literals are masked first, and the `export { … }` clause
 * is read for the exported name rather than pattern-matched: `export
 * { middleware as default }` mentions the word but exports nothing called
 * `middleware`, and that is exactly the mistake this check exists to catch.
 * A re-export (`export * from`) is treated as a match because its names cannot
 * be known without resolving the other module — better to miss one than to
 * fail a working app.
 */
/**
 * Whether a destructuring pattern binds a variable named `middleware`.
 *
 * `{ middleware }` and `[middleware]` do; `{ middleware: mw }` binds `mw`, and
 * `{ mw: middleware }` binds `middleware`. Renames are the whole point, so the
 * check reads which side of the `:` each name sits on.
 */
function bindsMiddleware(pattern: string): boolean {
  const parts = splitTopLevel(pattern.slice(1, -1));

  if (pattern.startsWith("[")) {
    return parts.some((element) => bindsName(element));
  }

  return parts.some((property) => {
    const separator = topLevelIndexOf(property, ":");
    // `{ auth: { middleware } }` binds `middleware`; `{ middleware: { inner } }`
    // does not. Only the value side can bind, so only it is inspected.
    return bindsName(separator === -1 ? property : property.slice(separator + 1));
  });
}

function bindsName(text: string): boolean {
  const bound = text
    .trim()
    .replace(/^\.\.\./, "")
    .replace(/\s*=.*$/, "")
    .trim();
  if (bound.startsWith("{") || bound.startsWith("[")) return bindsMiddleware(bound);
  return bound === "middleware";
}

/** Split on commas that are not inside a nested `{}` / `[]` / `()`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Index of the first `needle` at nesting depth 0, or -1. */
function topLevelIndexOf(text: string, needle: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === needle && depth === 0) return index;
  }
  return -1;
}

/**
 * Every destructuring pattern in an `export const|let|var` declaration.
 *
 * Scanned with a delimiter counter rather than a regex: a non-greedy match
 * stops at the first `}`, truncating a nested pattern
 * (`{ auth: { middleware } }`), and the optional type annotation between the
 * pattern and `=` is easier to skip explicitly than to express.
 */
function destructuredExportPatterns(code: string): string[] {
  const patterns: string[] = [];

  for (const match of code.matchAll(/export\s+(?:const|let|var)\s*(?=[{[])/g)) {
    const open = (match.index ?? 0) + match[0].length;
    const close = matchingDelimiter(code, open);
    if (close === -1) continue;

    // Skip an optional `: Type` annotation, then require the `=` that makes
    // this a declaration.
    if (!/^\s*(?::[^=]*)?=/.test(code.slice(close + 1))) continue;

    patterns.push(code.slice(open, close + 1));
  }

  return patterns;
}

/** Index of the delimiter closing the one at `open`, or -1. */
function matchingDelimiter(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function exportsMiddleware(source: string): boolean {
  const code = maskCommentsAndStrings(source);

  // export const/let/var/function/async function middleware
  if (/export\s+(?:async\s+)?(?:function|const|let|var)\s+middleware\b/.test(code)) return true;

  // export const { middleware } = …  /  export const [middleware] = …
  // The *bound* name has to be `middleware`: `{ middleware: mw }` binds `mw`
  // and exports nothing called `middleware`, the same trap as
  // `export { middleware as default }`.
  for (const pattern of destructuredExportPatterns(code)) {
    if (bindsMiddleware(pattern)) return true;
  }

  // Names cannot be resolved without the other module; assume the best.
  if (/export\s*\*\s*from/.test(code)) return true;

  for (const clause of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const specifier of clause[1].split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/);
      if (parts.length === 0 || parts[0] === "") continue;
      // `a as b` exports `b`; a bare `a` exports `a`.
      const exported = (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
      if (exported === "middleware") return true;
    }
  }

  return false;
}

/**
 * A registered middleware module that does not export `middleware` used to be
 * skipped at runtime, so an auth gate could be wired in the manifest and
 * absent in production while every check here passed. The runtime now refuses
 * to serve such a route; this check reports the same mistake before a request
 * ever reaches it.
 */
function collectMiddlewareExportChecks(
  checks: Check[],
  manifestPath: string,
  entries: { name: string; path: string }[],
): void {
  const manifestDir = dirname(manifestPath);
  const missing: string[] = [];

  for (const entry of entries) {
    const file = resolve(manifestDir, entry.path);
    if (!existsSync(file)) continue; // already reported by the module-path check
    if (!exportsMiddleware(readFileSync(file, "utf-8"))) {
      missing.push(`${entry.name} (${entry.path})`);
    }
  }

  if (missing.length === 0) {
    checks.push(
      createCheck("ok", `All ${entries.length} middleware module(s) export \`middleware\`.`),
    );
    return;
  }

  checks.push(
    createCheck(
      "error",
      `Middleware module(s) without a \`middleware\` export: ${missing.join(", ")}. ` +
        "Middleware must `export const middleware: MiddlewareFn = (args, next) => …` " +
        "(a default export is not used); routes referencing them fail at request time.",
    ),
  );
}

function collectChangedManifestModuleChecks(
  project: ProjectConfig,
  checks: Check[],
  manifestPath: string,
  relativeModules: string[],
  changedFiles: string[],
): void {
  const manifestDir = dirname(manifestPath);
  const referencedModules = new Set(relativeModules.map(normalizePath));
  const moduleDirectories = [
    { dir: resolveProjectPath(project.root, project.routesDir), label: "route module" },
    { dir: resolveProjectPath(project.root, project.shellsDir), label: "shell module" },
    { dir: resolveProjectPath(project.root, project.middlewareDir), label: "middleware module" },
    { dir: resolveProjectPath(project.root, project.serverDir), label: "server module" },
  ];

  for (const file of changedFiles) {
    const directory = moduleDirectories.find((entry) => isWithinDirectory(file, entry.dir));
    if (!directory) continue;
    if (!MODULE_SOURCE_RE.test(file)) continue;

    const display = displayPath(project.root, file);
    const modulePath = normalizePath(toModuleSpecifier(manifestDir, file));
    const exists = existsSync(file);

    if (referencedModules.has(modulePath)) {
      if (exists) {
        checks.push(
          createCheck(
            "ok",
            `Changed ${directory.label} ${JSON.stringify(display)} is referenced by the app manifest.`,
          ),
        );
      } else {
        checks.push(
          createCheck(
            "error",
            `Changed ${directory.label} ${JSON.stringify(display)} was removed but is still referenced by the app manifest.`,
          ),
        );
      }
      continue;
    }

    if (exists) {
      checks.push(
        createCheck(
          "warning",
          `Changed ${directory.label} ${JSON.stringify(display)} is not referenced by the app manifest.`,
        ),
      );
    }
  }
}
