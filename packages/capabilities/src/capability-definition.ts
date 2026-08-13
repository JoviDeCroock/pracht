import { isValidCapabilityHttpPath } from "./protocol.ts";
import {
  applySchemaDefaults,
  collectInvalidSchemaKeywordValues,
  collectUnsupportedSchemaKeywords,
  validateAgainstSchema,
} from "./schema.ts";
import type {
  Capability,
  CapabilityContext,
  CapabilityDefinition,
  CapabilityExposeConfig,
  CapabilityExposure,
  CapabilityHttpExposure,
  CapabilityValidationResult,
} from "./capability-types.ts";

export const DESTRUCTIVE_EXPOSURE_ERROR =
  "destructive capabilities cannot be exposed to agent projections (webmcp/mcp) yet — " +
  "only expose.http, where the prepare/commit confirmation flow gates every call";

export const MCP_SCHEMA_ROOT_ERROR =
  'expose.mcp requires "input" and "output" schemas with type: "object" for the supported MCP protocol versions';

/**
 * Define a protocol-neutral application capability.
 *
 * Fails fast on missing contract fields, schemas outside the supported JSON
 * Schema subset, WebMCP without HTTP enforcement, destructive agent exposure,
 * invalid HTTP paths, and MCP schemas unsupported by the negotiated protocol.
 */
export function defineCapability<TInput = unknown, TOutput = unknown, TContext = CapabilityContext>(
  definition: CapabilityDefinition<TInput, TOutput, TContext>,
): Capability<TInput, TOutput, TContext> {
  assertDefinition(definition);
  const expose = normalizeExposure(definition.expose);

  if (definition.effect === "destructive" && (expose?.webmcp || expose?.mcp)) {
    throw new Error(`defineCapability("${definition.title}"): ${DESTRUCTIVE_EXPOSURE_ERROR}.`);
  }
  if (expose?.webmcp && !expose.http) {
    throw new Error(
      `defineCapability("${definition.title}"): expose.webmcp requires expose.http — ` +
        "WebMCP page tools dispatch through the HTTP projection so all enforcement stays server-side.",
    );
  }
  if (expose?.mcp && (definition.input.type !== "object" || definition.output.type !== "object")) {
    throw new Error(`defineCapability("${definition.title}"): ${MCP_SCHEMA_ROOT_ERROR}.`);
  }

  return {
    kind: "capability",
    title: definition.title,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    effect: definition.effect,
    middleware: definition.middleware ?? [],
    expose,
    agentPolicy: definition.agentPolicy,
    run: definition.run,
    validateInput(value: unknown): CapabilityValidationResult<TInput> {
      const withDefaults = applySchemaDefaults(definition.input, value === undefined ? {} : value);
      const issues = validateAgainstSchema(definition.input, withDefaults);
      return issues.length > 0
        ? { ok: false, issues }
        : { ok: true, value: withDefaults as TInput };
    },
    validateOutput(value: unknown): CapabilityValidationResult<TOutput> {
      const issues = validateAgainstSchema(definition.output, value);
      return issues.length > 0 ? { ok: false, issues } : { ok: true, value: value as TOutput };
    },
  };
}

function assertDefinition(definition: CapabilityDefinition<never, unknown, never>): void {
  const label = typeof definition?.title === "string" ? definition.title : "<untitled>";
  if (!definition || typeof definition !== "object") {
    throw new Error("defineCapability expects a definition object.");
  }
  for (const field of ["title", "description"] as const) {
    if (typeof definition[field] !== "string" || definition[field].trim() === "") {
      throw new Error(`defineCapability("${label}"): "${field}" must be a non-empty string.`);
    }
  }
  if (!(["read", "write", "destructive"] as unknown[]).includes(definition.effect)) {
    throw new Error(
      `defineCapability("${label}"): "effect" must be "read", "write", or "destructive".`,
    );
  }
  if (typeof definition.run !== "function") {
    throw new Error(`defineCapability("${label}"): "run" must be a function.`);
  }

  for (const field of ["input", "output"] as const) {
    const schema = definition[field];
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error(`defineCapability("${label}"): "${field}" must be a JSON Schema object.`);
    }
    const unsupported = collectUnsupportedSchemaKeywords(schema);
    const invalid = collectInvalidSchemaKeywordValues(schema);
    if (unsupported.length > 0) {
      throw new Error(
        `defineCapability("${label}"): "${field}" schema uses unsupported JSON Schema keywords: ` +
          `${unsupported.join(", ")}. Supported keywords: type (object/array/string/number/` +
          "integer/boolean/null), properties, required, additionalProperties, items, enum, " +
          "const, minimum, maximum, minLength, maxLength, default, title, description.",
      );
    }
    if (invalid.length > 0) {
      throw new Error(
        `defineCapability("${label}"): "${field}" schema has invalid JSON Schema values: ` +
          `${invalid.join(", ")}.`,
      );
    }
  }

  if (
    definition.middleware !== undefined &&
    (!Array.isArray(definition.middleware) ||
      definition.middleware.some((name) => typeof name !== "string"))
  ) {
    throw new Error(`defineCapability("${label}"): "middleware" must be an array of names.`);
  }
  if (
    definition.agentPolicy !== undefined &&
    definition.agentPolicy !== "observe" &&
    definition.agentPolicy !== "require"
  ) {
    throw new Error(`defineCapability("${label}"): "agentPolicy" must be "observe" or "require".`);
  }
}

function normalizeExposure(expose: CapabilityExposeConfig | undefined): CapabilityExposure | null {
  if (!expose) return null;
  let http: CapabilityHttpExposure | null = null;
  if (expose.http === true) {
    http = { method: "POST" };
  } else if (expose.http && typeof expose.http === "object") {
    if (expose.http.method !== undefined && expose.http.method !== "POST") {
      throw new Error('Capability HTTP exposure only supports method: "POST" for now.');
    }
    if (expose.http.path !== undefined) {
      if (!isValidCapabilityHttpPath(expose.http.path)) {
        throw new Error(
          'Capability HTTP exposure "path" must be an exact same-origin pathname starting with "/".',
        );
      }
      http = { method: "POST", path: expose.http.path };
    } else {
      http = { method: "POST" };
    }
  }

  const normalized = { http, mcp: expose.mcp === true, webmcp: expose.webmcp === true };
  return !normalized.http && !normalized.mcp && !normalized.webmcp ? null : normalized;
}
