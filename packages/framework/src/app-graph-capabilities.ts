import { capabilityHttpPath } from "@pracht/capabilities";
import {
  extractCapabilityProjection,
  type CapabilityProjection,
} from "@pracht/capabilities/static";

import type {
  AppGraphCapability,
  AppGraphModuleAccess,
  SerializeCapabilitiesOptions,
} from "./app-graph-types.ts";
import type { PrachtCapability } from "./types.ts";

/**
 * Serialize registered capabilities by loading their modules. Modules that
 * fail to load (or don't export a capability) still appear in the graph with
 * null metadata so inspect/devtools can surface the broken registration.
 */
function readProjection(
  name: string,
  file: string,
  access: AppGraphModuleAccess,
): CapabilityProjection | null {
  try {
    return extractCapabilityProjection(name, access.readSource(file), (detail) => detail);
  } catch {
    return null;
  }
}

function projectionTransports(projection: CapabilityProjection | null): string[] {
  if (!projection) return [];
  const transports: string[] = [];
  if (projection.httpPath) transports.push("http");
  // Order matches the executed path so a fallback entry diffs against a
  // normally-read one without spurious churn.
  if (projection.mcp) transports.push("mcp");
  if (projection.webmcp) transports.push("webmcp");
  return transports;
}

export function serializeCapabilities(
  capabilities: Record<string, string> | undefined,
  access: AppGraphModuleAccess,
  options: SerializeCapabilitiesOptions = {},
): Promise<AppGraphCapability[]> {
  return Promise.all(
    Object.entries(capabilities ?? {}).map(async ([name, file]) => {
      try {
        const module = await access.loadModule(file);
        const capability = module.default as PrachtCapability | undefined;
        if (!capability || capability.kind !== "capability") {
          throw new Error("module does not default-export a capability");
        }

        const transports: string[] = [];
        if (capability.expose?.http) transports.push("http");
        if (capability.expose?.mcp) transports.push("mcp");
        if (capability.expose?.webmcp) transports.push("webmcp");

        return {
          agentPolicy: capability.agentPolicy ?? null,
          description: capability.description,
          effect: capability.effect,
          hasUi: false as const,
          httpPath: capability.expose?.http
            ? (capability.expose.http.path ?? capabilityHttpPath(name))
            : null,
          input: capability.input ?? null,
          middleware: capability.middleware ?? [],
          name,
          output: capability.output ?? null,
          source: file,
          title: capability.title,
          transports,
        };
      } catch (cause) {
        if (options.strict) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          throw new Error(
            `Failed to load capability ${JSON.stringify(name)} from ${JSON.stringify(file)} while resolving the app graph: ${detail}`,
            { cause },
          );
        }
        // Falling back to static analysis rather than reporting nothing.
        //
        // A capability module that cannot be *executed* here is often perfectly
        // healthy: a Cloudflare capability importing `cloudflare:workers` at
        // the top level deploys fine, it just cannot load in the CLI's Node
        // graph server. Reporting `effect: null, transports: []` for it would
        // claim the app exposes nothing — under-reporting the agent surface in
        // the dev banner, `inspect`, the committed snapshot, and generated
        // types alike. The same extractor the browser projection is built from
        // reads `expose` and `effect` straight out of the source, so use it and
        // keep `error` set for the diagnostic.
        const projection = readProjection(name, file, access);
        // `undefined` from the extractor means "declared, but not readable
        // statically". Recording it as `null` / `[]` would claim the
        // capability has no agent policy and no middleware — the two fields a
        // reviewer reads to decide whether a change weakened a guard, and the
        // ones `pracht plan` warns on. `unverifiedContract` says so instead.
        const unverified =
          !projection ||
          projection.agentPolicy === undefined ||
          projection.middleware === undefined;
        return {
          agentPolicy: projection?.agentPolicy ?? null,
          description: projection?.description ?? null,
          effect: projection?.effect ?? null,
          error: cause instanceof Error ? cause.message : String(cause),
          unverifiedContract: unverified ? (true as const) : undefined,
          hasUi: false as const,
          httpPath: projection?.httpPath ?? null,
          input: projection?.inputSchema ?? null,
          middleware: projection?.middleware ?? [],
          name,
          output: null,
          source: file,
          title: null,
          transports: projectionTransports(projection),
        };
      }
    }),
  );
}
