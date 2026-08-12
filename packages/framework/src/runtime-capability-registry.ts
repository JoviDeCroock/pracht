/**
 * Capability manifest resolution and route matching.
 *
 * This module owns registry loading, contract validation, cache identity, and
 * HTTP path collision checks. Execution and transport handling remain in
 * runtime-capabilities.ts.
 */

import {
  capabilityHttpPath,
  DEFAULT_MCP_ENDPOINT,
  isValidCapabilityHttpPath,
  isValidMcpToolName,
  MCP_SCHEMA_ROOT_ERROR,
  MCP_TOOL_NAME_ERROR,
  mcpToolName,
  normalizeCapabilityHttpPath,
} from "@pracht/capabilities";

import { formatUnknownNameError } from "./name-suggestions.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import type { CapabilityModule, ModuleRegistry, PrachtApp, PrachtCapability } from "./types.ts";

/** Names must be URL-safe: dot-separated segments of [a-z0-9_-]. */
const CAPABILITY_NAME_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i;

export interface ResolvedCapability {
  name: string;
  file: string;
  capability: PrachtCapability;
  /** Dispatch path when `expose.http` is set, `null` for private capabilities. */
  httpPath: string | null;
  middlewareFiles: string[];
}

export type CapabilityHostApp = Pick<PrachtApp, "agents" | "capabilities" | "middleware">;

// Resolution loads every registered capability module once per app manifest +
// registry instance. Resolution also depends on app-level middleware and MCP
// configuration, so keying only by the capabilities record could leak a result
// between distinct app manifests that happen to share that record. Dev HMR can
// keep the same app manifest object while replacing the generated registry
// after a capability edit, so both identities participate in the cache key.
const resolvedCapabilitiesCache = new WeakMap<
  object,
  WeakMap<object, Promise<ResolvedCapability[]>>
>();
const EMPTY_CAPABILITY_MODULES = {};

export function resolveAppCapabilities(
  app: CapabilityHostApp,
  registry: ModuleRegistry,
): Promise<ResolvedCapability[]> {
  const capabilityModules = registry.capabilityModules ?? EMPTY_CAPABILITY_MODULES;
  let registryCache = resolvedCapabilitiesCache.get(app);
  if (!registryCache) {
    registryCache = new WeakMap();
    resolvedCapabilitiesCache.set(app, registryCache);
  }
  let resolved = registryCache.get(capabilityModules);
  if (!resolved) {
    resolved = resolveAppCapabilitiesUncached(app, registry);
    registryCache.set(capabilityModules, resolved);
  }
  return resolved;
}

async function resolveAppCapabilitiesUncached(
  app: CapabilityHostApp,
  registry: ModuleRegistry,
): Promise<ResolvedCapability[]> {
  const resolved: ResolvedCapability[] = [];
  const seenHttpPaths = new Map<string, string>();
  const mcpEndpoint = app.agents?.mcp
    ? normalizeCapabilityHttpPath(app.agents.mcp.path ?? DEFAULT_MCP_ENDPOINT)
    : null;

  for (const [name, file] of Object.entries(app.capabilities ?? {})) {
    if (!CAPABILITY_NAME_RE.test(name)) {
      throw new Error(
        `Invalid capability name "${name}". Names must be dot-separated segments of ` +
          'letters, numbers, hyphens, and underscores (e.g. "notes.search").',
      );
    }

    const module = await resolveRegistryModule<CapabilityModule>(registry.capabilityModules, file);
    const capability = module?.default;
    if (!capability || capability.kind !== "capability") {
      throw new Error(
        `Capability "${name}" (${file}) must default-export the result of ` +
          "defineCapability() from @pracht/capabilities.",
      );
    }

    // `defineCapability()` already refuses these; re-check here so a
    // hand-rolled capability object fails closed before it can be served.
    // Destructive + HTTP is allowed (the prepare/commit confirmation flow
    // gates every dispatch); agent-initiated projections stay disallowed in v1.
    if (
      capability.effect === "destructive" &&
      (capability.expose?.webmcp || capability.expose?.mcp)
    ) {
      throw new Error(
        `Capability "${name}": destructive capabilities cannot be exposed to agent ` +
          "projections (webmcp/mcp) yet — only expose.http with the confirmation flow.",
      );
    }
    if (capability.expose?.webmcp && !capability.expose.http) {
      throw new Error(`Capability "${name}": expose.webmcp requires expose.http.`);
    }
    if (
      capability.expose?.mcp &&
      (capability.input?.type !== "object" || capability.output?.type !== "object")
    ) {
      throw new Error(`Capability "${name}": ${MCP_SCHEMA_ROOT_ERROR}.`);
    }
    if (capability.expose?.mcp && !isValidMcpToolName(mcpToolName(name))) {
      throw new Error(`Capability "${name}": ${MCP_TOOL_NAME_ERROR}.`);
    }
    if (
      capability.expose &&
      (typeof capability.validateInput !== "function" ||
        typeof capability.validateOutput !== "function" ||
        typeof capability.description !== "string" ||
        !capability.input ||
        !capability.output ||
        !capability.effect)
    ) {
      throw new Error(
        `Capability "${name}" is exposed but is missing its contract ` +
          "(description, input schema, output schema, effect, validators).",
      );
    }

    const middlewareFiles = (capability.middleware ?? []).map((middlewareName) => {
      const middlewareFile = app.middleware?.[middlewareName];
      if (!middlewareFile) {
        throw new Error(
          formatUnknownNameError({
            kind: "middleware",
            kindPlural: "middleware",
            name: middlewareName,
            registered: Object.keys(app.middleware ?? {}),
            context: `capability "${name}"`,
          }),
        );
      }
      return middlewareFile;
    });

    let httpPath: string | null = null;
    if (capability.expose?.http) {
      const configuredPath = capability.expose.http.path ?? capabilityHttpPath(name);
      if (!isValidCapabilityHttpPath(configuredPath)) {
        throw new Error(
          `Capability "${name}": HTTP exposure path must be an exact same-origin pathname ` +
            'starting with "/".',
        );
      }
      httpPath = normalizeCapabilityHttpPath(configuredPath);
      if (httpPath === mcpEndpoint) {
        throw new Error(
          `Capability "${name}" exposes HTTP path "${httpPath}", which is also the configured ` +
            "MCP endpoint. Choose a distinct agents.mcp.path or capability HTTP path.",
        );
      }
      const existing = seenHttpPaths.get(httpPath);
      if (existing) {
        throw new Error(
          `Capabilities "${existing}" and "${name}" both expose HTTP path "${httpPath}".`,
        );
      }
      seenHttpPaths.set(httpPath, name);
    }

    resolved.push({ name, file, capability, httpPath, middlewareFiles });
  }

  return resolved;
}

export function matchCapabilityRoute(
  capabilities: readonly ResolvedCapability[],
  pathname: string,
): ResolvedCapability | undefined {
  const normalized = normalizeCapabilityHttpPath(pathname);
  return capabilities.find((entry) => entry.httpPath === normalized);
}

/**
 * Best-effort path discovery used only after full registry resolution fails.
 * It recognizes valid capability modules independently so custom HTTP paths
 * still fail closed instead of falling through to an unrelated page route.
 */
export async function isRegisteredCapabilityHttpPath(
  app: CapabilityHostApp,
  registry: ModuleRegistry,
  pathname: string,
): Promise<boolean> {
  const normalized = normalizeCapabilityHttpPath(pathname);
  for (const [name, file] of Object.entries(app.capabilities ?? {})) {
    try {
      const module = await resolveRegistryModule<CapabilityModule>(
        registry.capabilityModules,
        file,
      );
      const capability = module?.default;
      if (capability?.kind !== "capability" || !capability.expose?.http) continue;
      const httpPath = normalizeCapabilityHttpPath(
        capability.expose.http.path ?? capabilityHttpPath(name),
      );
      if (httpPath === normalized) return true;
    } catch {
      // The full resolver reports the original error; this scan only identifies paths.
    }
  }
  return false;
}
