import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import {
  collectInvalidSchemaKeywordValues,
  collectUnsupportedSchemaKeywords,
} from "@pracht/capabilities";

import { extractRegistryEntries } from "./manifest.js";
import { resolveProjectPath, type ProjectConfig } from "./project.js";
import { createCheck, type Check } from "./verification-helpers.js";

const CAPABILITY_EFFECTS = new Set(["read", "write", "destructive"]);
const AGENT_POLICIES = new Set(["observe", "require"]);

/**
 * Static verification of registered capabilities (manifest mode only). These
 * checks mirror what `defineCapability()` and the runtime registry enforce,
 * but run without executing application code so `pracht verify` stays fast
 * and safe. Spec security rule 1: exposed capabilities without a full
 * contract (description, input, output, effect) fail verification. Spec rule
 * 3: destructive capabilities may only be exposed over HTTP, and only when
 * the prepare/commit confirmation secret (PRACHT_CONFIRMATION_SECRET) is
 * configured in the environment `pracht verify` runs in.
 */
export function collectCapabilityChecks(project: ProjectConfig, checks: Check[]): void {
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) return;

  const manifestSource = readFileSync(manifestPath, "utf-8");
  const entries = extractRegistryEntries(manifestSource, "capabilities");
  if (entries.length === 0) return;
  const registeredMiddleware = new Set(
    extractRegistryEntries(manifestSource, "middleware").map((entry) => entry.name),
  );

  checks.push(
    createCheck(
      "ok",
      `Registered ${entries.length} capabilit${entries.length === 1 ? "y" : "ies"}.`,
    ),
  );

  const manifestDir = dirname(manifestPath);
  for (const entry of entries) {
    const filePath = resolve(manifestDir, entry.path);
    if (!existsSync(filePath)) {
      // Missing manifest references are already reported by the manifest check.
      continue;
    }

    collectSingleCapabilityChecks(
      entry.name,
      entry.path,
      readFileSync(filePath, "utf-8"),
      registeredMiddleware,
      checks,
    );
  }
}

function collectSingleCapabilityChecks(
  name: string,
  displayPath: string,
  source: string,
  registeredMiddleware: Set<string>,
  checks: Check[],
): void {
  const label = `Capability ${JSON.stringify(name)} (${displayPath})`;
  const args = extractDefineCapabilityArgs(source);
  if (!args) {
    checks.push(
      createCheck(
        "error",
        `${label} does not contain a statically analyzable defineCapability({ ... }) call.`,
      ),
    );
    return;
  }

  const properties = scanTopLevelPropertyText(args);
  const exposed = properties.has("expose");
  const title = readStaticString(properties.get("title"));
  const description = readStaticString(properties.get("description"));
  const effect = readStaticString(properties.get("effect"));
  const problems: string[] = [];

  const missing: string[] = [];
  if (title.kind === "absent") missing.push("title");
  if (description.kind === "absent") missing.push("description");
  if (!properties.has("input")) missing.push("input schema");
  if (!properties.has("output")) missing.push("output schema");
  if (effect.kind === "absent") missing.push("effect");
  if (missing.length > 0) {
    problems.push(`is missing required fields: ${missing.join(", ")}`);
  }

  for (const [field, value] of [
    ["title", title],
    ["description", description],
    ["effect", effect],
  ] as const) {
    if (value.kind === "invalid") {
      problems.push(`"${field}" must be a non-empty string`);
    } else if (value.kind === "unknown") {
      checks.push(
        createCheck(
          "warning",
          `${label}: the "${field}" field is not an inline string literal, so it could not be verified statically.`,
        ),
      );
    }
  }

  const effectValue = effect.kind === "valid" ? effect.value : null;
  if (effectValue && !CAPABILITY_EFFECTS.has(effectValue)) {
    problems.push('"effect" must be "read", "write", or "destructive"');
  }

  const agentPolicy = readStaticString(properties.get("agentPolicy"));
  if (properties.has("agentPolicy")) {
    if (agentPolicy.kind === "unknown") {
      checks.push(
        createCheck(
          "warning",
          `${label}: the "agentPolicy" field is not an inline string literal, so it could not be verified statically.`,
        ),
      );
    } else if (agentPolicy.kind !== "valid" || !AGENT_POLICIES.has(agentPolicy.value)) {
      problems.push('"agentPolicy" must be "observe" or "require"');
    }
  }

  const middleware = readMiddlewareNames(properties.get("middleware"));
  if (middleware.kind === "invalid") {
    problems.push('"middleware" must be an array of names');
  } else if (middleware.kind === "unknown") {
    checks.push(
      createCheck(
        "warning",
        `${label}: the "middleware" field is not an inline array literal, so it could not be verified statically.`,
      ),
    );
  } else if (middleware.kind === "valid") {
    for (const middlewareName of middleware.names) {
      if (!registeredMiddleware.has(middlewareName)) {
        problems.push(`references unknown middleware ${JSON.stringify(middlewareName)}`);
      }
    }
  }

  const exposeFlags = readExposeFlags(properties.get("expose"));
  problems.push(...exposeFlags.problems);

  if (exposed) {
    const { hasHttp, hasMcp, hasWebmcp } = exposeFlags;
    if (hasWebmcp && !hasHttp) {
      problems.push(
        "sets expose.webmcp without expose.http — WebMCP tools dispatch through the HTTP projection",
      );
    }

    if (effectValue === "destructive") {
      if (hasWebmcp || hasMcp) {
        problems.push(
          "is destructive and exposed to agent projections (webmcp/mcp) — only expose.http " +
            "is allowed, gated by the prepare/commit confirmation flow",
        );
      } else if (hasHttp && !process.env.PRACHT_CONFIRMATION_SECRET) {
        problems.push(
          "is destructive and exposed over HTTP without PRACHT_CONFIRMATION_SECRET in the " +
            "environment — the prepare/commit confirmation flow needs the secret and the " +
            "runtime fails closed without it",
        );
      }
    }
  }

  for (const field of ["input", "output"] as const) {
    const schemaText = properties.get(field);
    if (!schemaText) continue;
    const schema = evaluateLiteral(schemaText);
    if (schema === undefined) {
      checks.push(
        createCheck(
          "warning",
          `${label}: the "${field}" schema is not an inline object literal, so its JSON Schema subset could not be verified statically.`,
        ),
      );
      continue;
    }
    const unsupported = collectUnsupportedSchemaKeywords(schema);
    if (unsupported.length > 0) {
      problems.push(
        `"${field}" schema uses unsupported JSON Schema keywords: ${unsupported.join(", ")}`,
      );
    }
    const invalid = collectInvalidSchemaKeywordValues(schema);
    if (invalid.length > 0) {
      problems.push(`"${field}" schema has invalid JSON Schema values: ${invalid.join(", ")}`);
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      checks.push(createCheck("error", `${label} ${problem}.`));
    }
    return;
  }

  checks.push(
    createCheck(
      "ok",
      `${label} declares a complete ${exposed ? "exposed" : "private"} contract${effectValue ? ` (effect: ${effectValue})` : ""}.`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Static analysis helpers (quote/comment/depth aware)
// ---------------------------------------------------------------------------

function extractDefineCapabilityArgs(source: string): string | null {
  // Match the call site (optionally with a type argument), not the import.
  const callMatch = /defineCapability\s*(?:<[^(]*?>)?\s*\(/.exec(source);
  if (!callMatch || callMatch.index == null) return null;
  const braceStart = source.indexOf("{", callMatch.index + callMatch[0].length - 1);
  if (braceStart === -1) return null;
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}

/** Map of top-level property name → raw value text of an object literal body. */
function scanTopLevelPropertyText(objectBody: string): Map<string, string> {
  const properties = new Map<string, string>();
  let index = 0;

  while (index < objectBody.length) {
    index = skipInsignificant(objectBody, index);
    if (index >= objectBody.length) break;

    let key: string | null = null;
    const char = objectBody[index];
    if (char === '"' || char === "'") {
      const end = findStringEnd(objectBody, index);
      if (end === -1) break;
      key = objectBody.slice(index + 1, end);
      index = end + 1;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(objectBody.slice(index));
      if (!match) break;
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(objectBody, index);
    if (objectBody[index] !== ":") {
      index = skipToTopLevelComma(objectBody, index) + 1;
      continue;
    }
    index += 1;

    const valueStart = skipInsignificant(objectBody, index);
    const valueEnd = skipToTopLevelComma(objectBody, valueStart);
    properties.set(key, objectBody.slice(valueStart, valueEnd).trim());
    index = valueEnd + 1;
  }

  return properties;
}

function skipToTopLevelComma(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return source.length;
      index = end + 1;
      continue;
    }
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipInsignificant(source, index);
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) return index;
    index += 1;
  }
  return source.length;
}

function skipInsignificant(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const blockEnd = source.indexOf("*/", index + 2);
      index = blockEnd === -1 ? source.length : blockEnd + 2;
      continue;
    }
    break;
  }
  return index;
}

function findStringEnd(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

function findMatchingBrace(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return -1;
      index = end;
      continue;
    }
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipInsignificant(source, index) - 1;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

type StaticString =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "unknown" }
  | { kind: "valid"; value: string };

function readStaticString(text: string | undefined): StaticString {
  if (!text) return { kind: "absent" };
  const value = evaluateLiteral(text);
  if (value === undefined) return { kind: "unknown" };
  if (typeof value !== "string" || value.trim() === "") return { kind: "invalid" };
  return { kind: "valid", value };
}

type MiddlewareNames =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "unknown" }
  | { kind: "valid"; names: string[] };

function readMiddlewareNames(text: string | undefined): MiddlewareNames {
  if (!text) return { kind: "absent" };
  const value = evaluateLiteral(text);
  if (value === undefined) return { kind: "unknown" };
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    return { kind: "invalid" };
  }
  return { kind: "valid", names: value };
}

function readExposeFlags(text: string | undefined): {
  hasHttp: boolean;
  hasMcp: boolean;
  hasWebmcp: boolean;
  problems: string[];
} {
  const value = text ? evaluateLiteral(text) : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { hasHttp: false, hasMcp: false, hasWebmcp: false, problems: [] };
  }
  const expose = value as Record<string, unknown>;
  const problems: string[] = [];
  let hasHttp = false;
  if (expose.http === true) {
    hasHttp = true;
  } else if (expose.http && typeof expose.http === "object" && !Array.isArray(expose.http)) {
    hasHttp = true;
    const http = expose.http as Record<string, unknown>;
    if (http.method !== undefined && http.method !== "POST") {
      problems.push('HTTP exposure only supports method: "POST"');
    }
    if (http.path !== undefined && (typeof http.path !== "string" || !http.path.startsWith("/"))) {
      problems.push('HTTP exposure "path" must be a string starting with "/"');
    }
  } else if (expose.http !== undefined && expose.http !== false && expose.http !== null) {
    problems.push('"expose.http" must be true or an object');
  }

  return {
    hasHttp,
    hasMcp: expose.mcp === true,
    hasWebmcp: expose.webmcp === true,
    problems,
  };
}

/** Parse an extracted data literal without evaluating application code. */
function evaluateLiteral(expression: string): unknown {
  const parsed = parseLiteralValue(expression, 0);
  if (!parsed) return undefined;
  const end = skipInsignificant(expression, parsed.index);
  return end === expression.length ? parsed.value : undefined;
}

interface ParsedLiteral {
  value: unknown;
  index: number;
}

function parseLiteralValue(source: string, start: number): ParsedLiteral | null {
  const index = skipInsignificant(source, start);
  const char = source[index];
  if (char === "{") return parseObjectLiteral(source, index);
  if (char === "[") return parseArrayLiteral(source, index);
  if (char === '"' || char === "'" || char === "`") return parseStringLiteral(source, index);
  if (source.startsWith("true", index)) return parseKeyword(source, index, "true", true);
  if (source.startsWith("false", index)) return parseKeyword(source, index, "false", false);
  if (source.startsWith("null", index)) return parseKeyword(source, index, "null", null);
  return parseNumberLiteral(source, index);
}

function parseObjectLiteral(source: string, start: number): ParsedLiteral | null {
  const value: Record<string, unknown> = {};
  let index = skipInsignificant(source, start + 1);
  if (source[index] === "}") return { value, index: index + 1 };

  while (index < source.length) {
    let key: string | null = null;
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const parsedKey = parseStringLiteral(source, index);
      if (!parsedKey || typeof parsedKey.value !== "string") return null;
      key = parsedKey.value;
      index = parsedKey.index;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
      if (!match) return null;
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(source, index);
    if (source[index] !== ":") return null;

    const parsedValue = parseLiteralValue(source, index + 1);
    if (!parsedValue) return null;
    value[key] = parsedValue.value;

    index = skipInsignificant(source, parsedValue.index);
    if (source[index] === "}") return { value, index: index + 1 };
    if (source[index] !== ",") return null;
    index = skipInsignificant(source, index + 1);
    if (source[index] === "}") return { value, index: index + 1 };
  }

  return null;
}

function parseArrayLiteral(source: string, start: number): ParsedLiteral | null {
  const value: unknown[] = [];
  let index = skipInsignificant(source, start + 1);
  if (source[index] === "]") return { value, index: index + 1 };

  while (index < source.length) {
    const parsedValue = parseLiteralValue(source, index);
    if (!parsedValue) return null;
    value.push(parsedValue.value);

    index = skipInsignificant(source, parsedValue.index);
    if (source[index] === "]") return { value, index: index + 1 };
    if (source[index] !== ",") return null;
    index = skipInsignificant(source, index + 1);
    if (source[index] === "]") return { value, index: index + 1 };
  }

  return null;
}

function parseStringLiteral(source: string, start: number): ParsedLiteral | null {
  const quote = source[start];
  const end = findStringEnd(source, start);
  if (end === -1) return null;
  const body = source.slice(start + 1, end);
  if (quote === "`" && body.includes("${")) return null;

  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      value += char;
      continue;
    }

    index += 1;
    if (index >= body.length) return null;
    const escaped = body[index];
    switch (escaped) {
      case "b":
        value += "\b";
        break;
      case "f":
        value += "\f";
        break;
      case "n":
        value += "\n";
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "v":
        value += "\v";
        break;
      case "0":
        value += "\0";
        break;
      case "x": {
        const hex = body.slice(index + 1, index + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      case "u": {
        const hex = body.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        value += escaped;
        break;
    }
  }

  return { value, index: end + 1 };
}

function parseKeyword(
  source: string,
  start: number,
  keyword: string,
  value: unknown,
): ParsedLiteral | null {
  const end = start + keyword.length;
  return /[A-Za-z0-9_$]/.test(source[end] ?? "") ? null : { value, index: end };
}

function parseNumberLiteral(source: string, start: number): ParsedLiteral | null {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(start));
  if (!match) return null;
  const end = start + match[0].length;
  if (/[A-Za-z0-9_$]/.test(source[end] ?? "")) return null;
  return { value: Number(match[0]), index: end };
}
