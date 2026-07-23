import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import {
  collectInvalidSchemaKeywordValues,
  collectUnsupportedSchemaKeywords,
} from "@pracht/capabilities";
import {
  evaluateLiteral,
  extractDefineCapabilityArgs,
  scanTopLevelProperties,
} from "@pracht/capabilities/static";

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

  const properties = scanTopLevelProperties(args);
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

  if (exposeFlags.unknown) {
    checks.push(
      createCheck(
        "warning",
        `${label}: the "expose" field is not an inline object literal, so its exposure contract ` +
          "could not be verified statically — including the destructive-exposure and " +
          "confirmation-secret checks. Inline the expose object so verification can cover it.",
      ),
    );
  }

  if (exposed && !exposeFlags.unknown) {
    const { hasHttp, hasMcp, hasWebmcp } = exposeFlags;
    if (hasWebmcp && !hasHttp) {
      problems.push(
        "sets expose.webmcp without expose.http — WebMCP tools dispatch through the HTTP projection",
      );
    }

    if (hasMcp && effectValue !== "destructive") {
      checks.push(
        createCheck(
          "warning",
          `${label} sets expose.mcp, which is recorded in the graph but not served yet — ` +
            "the remote MCP projection is capability-graph Stage 2 (see docs/CAPABILITY_GRAPH.md).",
        ),
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

  if (exposeFlags.unknown) {
    // The exposure contract could not be verified; the warning above already
    // says so. Don't claim a complete contract.
    return;
  }

  checks.push(
    createCheck(
      "ok",
      `${label} declares a complete ${exposed ? "exposed" : "private"} contract${effectValue ? ` (effect: ${effectValue})` : ""}.`,
    ),
  );
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
  /** `expose` is present but not an inline literal, so it can't be verified. */
  unknown: boolean;
  problems: string[];
} {
  const value = text ? evaluateLiteral(text) : undefined;
  if (text !== undefined && value === undefined) {
    return { hasHttp: false, hasMcp: false, hasWebmcp: false, unknown: true, problems: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { hasHttp: false, hasMcp: false, hasWebmcp: false, unknown: false, problems: [] };
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
    unknown: false,
    problems,
  };
}
