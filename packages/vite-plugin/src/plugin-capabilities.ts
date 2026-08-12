/**
 * Build-time capability discovery for the Vite plugin.
 *
 * The analyzer lives in `@pracht/capabilities/static` and is shared with
 * `pracht verify`, so build and verification agree on what is statically
 * projectable. This module resolves registrations and serializable metadata;
 * browser virtual-module generation lives in capability-browser-codegen.ts.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  extractDefineAppObjectBody,
  extractCapabilityProjection,
  extractCapabilityRegistrations,
  scanTopLevelProperties,
} from "@pracht/capabilities/static";
import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";

export { extractCapabilityRegistrations };

export interface ExtractedCapability {
  name: string;
  /** Manifest-relative module path, e.g. "./capabilities/notes-search.ts". */
  file: string;
  description: string;
  effect: string | null;
  httpPath: string | null;
  webmcp: boolean;
  inputSchema: Record<string, unknown> | null;
}

/**
 * Whether the app can reach the agent surface at all — registered capabilities
 * or a `defineApp({ agents })` config. Drives the `__PRACHT_AGENT_SURFACE__`
 * define, which lets the bundler drop the capability and Web Bot Auth runtimes
 * from the server bundle of apps that use neither.
 *
 * Deliberately one-sided: it only answers `false` when the manifest is readable
 * and provably free of both. An unreadable manifest, a parse failure, or any
 * spread inside the manifest file (which could carry registrations this
 * analyzer cannot see) answers `true`, so the runtime keeps deciding for
 * itself. Being wrong the other way would 404 a capability in production that
 * works in dev.
 */
export function hasAgentSurface(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): boolean {
  const resolved = resolveOptions(options);
  // The pages router has no manifest: nowhere to register capabilities or agents.
  if (resolved.pagesDir) return false;

  const appFileAbs = resolve(root, resolved.appFile.replace(/^\//, ""));
  let manifestSource: string;
  try {
    manifestSource = readFileSync(appFileAbs, "utf-8");
  } catch {
    return true;
  }

  const appBody = extractDefineAppObjectBody(manifestSource);
  // A non-literal defineApp(config) call is opaque to static analysis. It may
  // carry capabilities or agents, so keep the runtime rather than silently
  // changing production behavior.
  if (appBody === null) return true;

  // Decode quoted property keys before deciding. The regex also covers
  // ordinary identifier and shorthand properties without requiring a value.
  const properties = scanTopLevelProperties(appBody);
  if (properties.has("agents") || properties.has("capabilities")) return true;
  if (/\b(?:agents|capabilities)\b/.test(appBody)) return true;
  // Spreads, computed keys, and escaped identifier keys can hide either name
  // behind syntax this lightweight analyzer does not fully evaluate.
  if (appBody.includes("...") || hasOpaqueTopLevelProperty(appBody)) return true;

  try {
    return extractCapabilityRegistrations(manifestSource).length > 0;
  } catch {
    return true;
  }
}

/** Whether an object literal body contains an opaque key at its top level. */
function hasOpaqueTopLevelProperty(objectBody: string): boolean {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let expectingKey = true;

  for (let index = 0; index < objectBody.length; index += 1) {
    const char = objectBody[index];
    const next = objectBody[index + 1];

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      for (index += 1; index < objectBody.length; index += 1) {
        if (objectBody[index] === "\\") {
          index += 1;
        } else if (objectBody[index] === quote) {
          break;
        }
      }
      continue;
    }

    if (char === "/" && next === "/") {
      index = objectBody.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = objectBody.indexOf("*/", index + 2);
      if (end === -1) return true;
      index = end + 1;
      continue;
    }
    // Distinguishing division from a regular-expression literal requires a
    // full lexer. Treat either as opaque: counting delimiters inside a regex
    // could otherwise hide a later computed agent-surface key and make this
    // production-only optimization incorrectly answer false.
    if (char === "/") return true;

    const atTopLevel = braces === 0 && brackets === 0 && parentheses === 0;
    if (atTopLevel && expectingKey && char === "[") return true;
    if (atTopLevel && expectingKey && char === "\\") return true;
    if (atTopLevel && char === ":") expectingKey = false;
    if (atTopLevel && char === ",") expectingKey = true;

    if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "(") parentheses += 1;
    else if (char === ")") parentheses -= 1;
  }

  return false;
}

/**
 * Extract capability registrations (name → module path) from the app
 * manifest source and their exposure metadata from each capability source.
 * Pages-router apps have no manifest, so capabilities are manifest-mode only.
 */
export function extractCapabilities(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): ExtractedCapability[] {
  const resolved = resolveOptions(options);
  if (resolved.pagesDir) return [];

  const appFileAbs = resolve(root, resolved.appFile.replace(/^\//, ""));
  let manifestSource: string;
  try {
    manifestSource = readFileSync(appFileAbs, "utf-8");
  } catch {
    return [];
  }

  const registrations = extractCapabilityRegistrations(manifestSource);
  if (registrations.length === 0) return [];

  const appDir = dirname(appFileAbs);
  return registrations.map(({ name, file }) => {
    // Root-relative refs (`/src/capabilities/x.ts`) resolve against the Vite
    // root, matching the runtime registry loader; everything else is relative
    // to the app manifest's directory.
    const capabilityFileAbs = file.startsWith("/")
      ? resolve(root, file.replace(/^\//, ""))
      : resolve(appDir, file);
    let source: string;
    try {
      source = readFileSync(capabilityFileAbs, "utf-8");
    } catch {
      throw new Error(
        `[pracht] Capability "${name}" references missing file ${JSON.stringify(file)}.`,
      );
    }
    return extractCapabilityMetadata(name, file, source);
  });
}

/**
 * Absolute paths of the capability modules the manifest registers.
 *
 * The client-import guard uses this rather than a `capabilitiesDir` prefix
 * test: registration is what makes a module server-only, and the manifest may
 * point anywhere. A directory test both misses capabilities registered from
 * elsewhere and wrongly rejects ordinary co-located files (shared constants,
 * types) that happen to sit in the capability folder.
 *
 * Returns an empty list when the manifest cannot be read or parsed — the
 * virtual-module generation raises its own precise error for those, and
 * guessing here would turn one clear failure into two confusing ones.
 */
export function resolveCapabilityModulePaths(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): string[] {
  const resolved = resolveOptions(options);
  if (resolved.pagesDir) return [];

  const appFileAbs = resolve(root, resolved.appFile.replace(/^\//, ""));
  let manifestSource: string;
  try {
    manifestSource = readFileSync(appFileAbs, "utf-8");
  } catch {
    return [];
  }

  const appDir = dirname(appFileAbs);
  return extractCapabilityRegistrations(manifestSource).map(({ file }) =>
    file.startsWith("/") ? resolve(root, file.replace(/^\//, "")) : resolve(appDir, file),
  );
}

function extractCapabilityMetadata(
  name: string,
  file: string,
  source: string,
): ExtractedCapability {
  // The projection rules live in @pracht/capabilities so the build, `pracht
  // verify`, and `pracht typegen` cannot drift on what a capability exposes.
  const projection = extractCapabilityProjection(
    name,
    source,
    (detail) => `[pracht] Capability ${JSON.stringify(name)} (${file}) ${detail}`,
  );
  return { name, file, ...projection };
}

export function hasWebmcpCapabilities(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): boolean {
  try {
    return extractCapabilities(options, root).some((capability) => capability.webmcp);
  } catch {
    // Extraction errors surface when the virtual modules are generated.
    return true;
  }
}
