import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveMcpEndpoint, serializeApiRoutes, serializeAppRoutes } from "@pracht/core";
import type {
  AppGraphApiRoute,
  AppGraphCapability,
  AppGraphRoute,
  PrachtAgentsConfig,
  ResolvedApiRoute,
} from "@pracht/core";
import { defineCommand } from "citty";

import { collectCapabilityAppGraph } from "../app-graph.js";
import { resolveBuildLlmsTxtEnabled, withAppServer } from "../app-server.js";
import { handleCliError } from "../utils.js";
import { readClientBuildAssets } from "../build-metadata.js";

const INSPECT_TARGETS = new Set(["routes", "api", "capabilities", "agents", "build", "all"]);

export default defineCommand({
  meta: {
    name: "inspect",
    description: "Inspect resolved app graph",
  },
  args: {
    target: {
      type: "positional",
      description: "Inspect target: routes, api, capabilities, agents, build, or all",
      required: false,
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    const target = args.target || "all";

    if (!INSPECT_TARGETS.has(target)) {
      handleCliError(
        new Error(
          `Unknown inspect target ${JSON.stringify(target)}. Valid targets: ${[...INSPECT_TARGETS].join(", ")}.`,
        ),
        { json: Boolean(args.json) },
      );
    }

    const report = await runInspect(process.cwd(), { target });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    printInspectReport(report);
  },
});

/**
 * `AppGraphRoute` plus the *effective* hydration mode.
 *
 * The graph stores what the manifest authored, so an unset `hydration` is
 * `null` — correct for diffing, but it leaves a machine reader unable to tell
 * the effective mode without hard-coding the framework default. The snapshot
 * format stays byte-identical (a changed serialization would mark every
 * committed `.pracht/app-graph.json` stale); this field is additive and
 * inspect-only.
 */
export interface InspectRoute extends AppGraphRoute {
  hydrationEffective: string;
}

/**
 * The configured agent surface, rolled up from the same resolved manifest the
 * other targets read. Answers "what can an agent reach, on which transport,
 * under which policy" without making a reviewer diff the per-capability list
 * against `defineApp({ agents })` by hand.
 */
export interface InspectAgents {
  webBotAuth: {
    enabled: boolean;
    /** App-wide default policy; `"observe"` when unset. */
    policy: string;
    staticKeys: number;
    directories: string[];
  };
  confirmation: {
    /** `"token"` unless the app opts into human approval. */
    mode: string;
    ttlSeconds: number | null;
    singleUse: boolean;
  };
  mcp: {
    enabled: boolean;
    /** Endpoint pathname, or `null` when `agents.mcp` is unconfigured. */
    endpoint: string | null;
  };
  llmsTxt: {
    /** Whether the resolved vite plugin configuration enables `llmsTxt`. */
    enabled: boolean | null;
  };
  /** One row per capability, in manifest order. */
  capabilities: {
    name: string;
    effect: string | null;
    /** Per-capability override of the app-wide Web Bot Auth policy. */
    agentPolicy: string | null;
    transports: string[];
    httpPath: string | null;
  }[];
  /** How many capabilities each transport exposes; `private` means none. */
  exposure: { http: number; webmcp: number; mcp: number; private: number };
}

export interface InspectReport {
  agents?: InspectAgents;
  api?: AppGraphApiRoute[];
  capabilities?: AppGraphCapability[];
  build?: {
    adapterTarget: string;
    clientEntryUrl: string | null;
    cssManifest: Record<string, string[]>;
    jsManifest: Record<string, string[]>;
  };
  mode: string;
  mcpDestructive?: boolean;
  mcpEndpoint?: string | null;
  mcpRuntimeStatus?: "blocked" | "not-configured" | "ready" | "unverified";
  mcpUnavailableReasons?: string[];
  notFound?: InspectRoute | null;
  routes?: InspectRoute[];
}

function withEffectiveHydration(route: AppGraphRoute): InspectRoute {
  return { ...route, hydrationEffective: route.hydration ?? "full" };
}

export async function runInspect(
  root: string,
  {
    inspectApiMethods = true,
    target = "all",
  }: { inspectApiMethods?: boolean; target?: string | string[] } = {},
): Promise<InspectReport> {
  const targets = new Set(Array.isArray(target) ? target : [target]);
  const wants = (name: string) => targets.has(name) || targets.has("all");
  const llmsTxtEnabled = wants("agents") ? await resolveBuildLlmsTxtEnabled(root) : null;

  return withAppServer(root, async ({ project, server, serverModule }) => {
    const report: InspectReport = {
      mode: project.mode,
    };

    if (wants("routes")) {
      report.routes = serializeAppRoutes(serverModule.resolvedApp.routes).map(
        withEffectiveHydration,
      );
      const notFound = serverModule.resolvedApp.notFound;
      report.notFound = notFound ? withEffectiveHydration(serializeAppRoutes([notFound])[0]) : null;
    }

    if (wants("api")) {
      report.api = inspectApiMethods
        ? await serializeApiRoutes(
            serverModule.apiRoutes,
            {
              loadModule: (file) => server.ssrLoadModule(file),
              readSource: (file) => readFileSync(resolve(root, `.${file}`), "utf-8"),
            },
            { strict: true },
          )
        : (serverModule.apiRoutes as ResolvedApiRoute[]).map(({ file, path }) => ({
            file,
            hasDefaultHandler: false,
            methods: [],
            path,
          }));
    }

    // `agents` is a rollup of the same capability graph, so resolve it once.
    const capabilityGraph =
      wants("capabilities") || wants("agents")
        ? await collectCapabilityAppGraph(server, root, serverModule, {
            appFile: project.appFile,
            strict: true,
          })
        : null;

    if (capabilityGraph) {
      report.mcpDestructive = capabilityGraph.mcpDestructive;
      report.mcpEndpoint = capabilityGraph.mcpEndpoint;
      report.mcpRuntimeStatus = capabilityGraph.mcpRuntimeStatus;
      report.mcpUnavailableReasons = capabilityGraph.mcpUnavailableReasons;
    }

    if (wants("capabilities") && capabilityGraph) {
      report.capabilities = capabilityGraph.capabilities;
    }

    if (wants("agents") && capabilityGraph) {
      report.agents = summarizeAgentSurface(
        serverModule.resolvedApp.agents,
        capabilityGraph.capabilities,
        llmsTxtEnabled,
      );
    }

    if (wants("build")) {
      const buildBase =
        typeof (serverModule as { buildBase?: unknown }).buildBase === "string"
          ? (serverModule as { buildBase: string }).buildBase
          : "/";
      const buildAssets = readClientBuildAssets(root, buildBase);
      report.build = {
        adapterTarget: serverModule.buildTarget,
        clientEntryUrl: buildAssets.clientEntryUrl,
        cssManifest: buildAssets.cssManifest,
        jsManifest: buildAssets.jsManifest,
      };
    }

    return report;
  });
}

export function summarizeAgentSurface(
  agents: PrachtAgentsConfig | undefined,
  capabilities: AppGraphCapability[],
  llmsTxtEnabled: boolean | null,
): InspectAgents {
  const exposure = { http: 0, webmcp: 0, mcp: 0, private: 0 };
  for (const capability of capabilities) {
    if (capability.transports.length === 0) {
      exposure.private += 1;
      continue;
    }
    for (const transport of capability.transports) {
      if (transport === "http" || transport === "webmcp" || transport === "mcp") {
        exposure[transport] += 1;
      }
    }
  }

  return {
    webBotAuth: {
      // `agents.webBotAuth` present at all means signatures are verified;
      // `policy` only decides whether an unverified caller is refused.
      enabled: agents?.webBotAuth !== undefined,
      policy: agents?.webBotAuth?.policy ?? "observe",
      staticKeys: agents?.webBotAuth?.keys?.length ?? 0,
      directories: agents?.webBotAuth?.directories ?? [],
    },
    confirmation: {
      mode: agents?.confirmation?.mode ?? "token",
      ttlSeconds: agents?.confirmation?.ttlSeconds ?? null,
      singleUse: agents?.confirmation?.singleUse ?? false,
    },
    mcp: {
      enabled: agents?.mcp !== undefined,
      endpoint: resolveMcpEndpoint(agents),
    },
    llmsTxt: { enabled: llmsTxtEnabled },
    capabilities: capabilities.map((capability) => ({
      name: capability.name,
      effect: capability.effect,
      agentPolicy: capability.agentPolicy,
      transports: capability.transports,
      httpPath: capability.httpPath,
    })),
    exposure,
  };
}

function formatCapabilityTransports(
  capability: Pick<AppGraphCapability, "effect" | "transports">,
  report: InspectReport,
): string {
  return capability.transports.length > 0
    ? capability.transports
        .map((transport) =>
          transport !== "mcp"
            ? transport
            : report.mcpEndpoint === null ||
                (capability.effect === "destructive" && report.mcpDestructive !== true) ||
                report.mcpRuntimeStatus === "blocked"
              ? "mcp(unserved)"
              : report.mcpRuntimeStatus === "unverified"
                ? "mcp(unverified)"
                : transport,
        )
        .join(",")
    : "private";
}

function printMcpInspectionStatus(report: InspectReport): void {
  if (report.mcpEndpoint !== null) {
    console.log(`  MCP endpoint: ${report.mcpEndpoint}`);
  }
  if ((report.mcpUnavailableReasons?.length ?? 0) > 0) {
    console.log(
      report.mcpRuntimeStatus === "unverified"
        ? `  ! MCP endpoint unverified: ${report.mcpUnavailableReasons!.join(" ")} Registrations in the adapter server entry are not evaluated by graph-only inspection.`
        : `  ! MCP endpoint unavailable: ${report.mcpUnavailableReasons!.join(" ")}`,
    );
  }
}

function printInspectReport(report: InspectReport): void {
  console.log(`Pracht inspect (${report.mode} mode)`);

  if (report.routes) {
    console.log("\nRoutes");
    for (const route of report.routes) {
      // Shell and middleware belong here, not only in `--json`: this is the
      // view a human reviewer reads, and middleware is the security-relevant
      // column (a route silently losing its auth gate should be visible).
      console.log(
        `  ${route.path}  id=${route.id}  render=${route.render ?? "n/a"}  hydration=${route.hydration ?? "full"}` +
          `  shell=${route.shell ?? "none"}  middleware=[${route.middleware.join(", ")}]  file=${route.file}`,
      );
    }

    console.log("\nNot found page");
    console.log(
      report.notFound
        ? `  ${report.notFound.path}  shell=${report.notFound.shell ?? "n/a"}  hydration=${report.notFound.hydration ?? "full"}  middleware=[${report.notFound.middleware.join(", ")}]  file=${report.notFound.file}`
        : "  None declared — unmatched URLs return a plain-text 404.",
    );
  }

  if (report.api) {
    console.log("\nAPI");
    if (report.api.length === 0) {
      console.log("  No API routes found.");
    } else {
      for (const route of report.api) {
        const explicitMethods = route.methods.join(",");
        const methods = route.hasDefaultHandler
          ? explicitMethods
            ? `${explicitMethods}+default`
            : "default"
          : explicitMethods || "none";
        console.log(`  ${route.path}  methods=${methods}  file=${route.file}`);
      }
    }
  }

  if (report.capabilities) {
    console.log("\nCapabilities");
    if (report.capabilities.length === 0) {
      console.log("  No capabilities registered.");
    } else {
      for (const capability of report.capabilities) {
        const transports = formatCapabilityTransports(capability, report);
        console.log(
          `  ${capability.name}  effect=${capability.effect ?? "n/a"}  transports=${transports}  ` +
            `http=${capability.httpPath ?? "n/a"}  file=${capability.source}`,
        );
        // Effect and exposure above came from static analysis; the schemas
        // could not be read. Say so rather than presenting a partial contract
        // as a complete one.
        if (capability.error) {
          console.log(
            `    ! schemas unavailable — module could not be loaded: ${capability.error}`,
          );
        }
      }
    }
    if (!report.agents) {
      printMcpInspectionStatus(report);
    }
  }

  if (report.agents) {
    const agents = report.agents;
    console.log("\nAgents");
    console.log(
      `  webBotAuth=${agents.webBotAuth.enabled ? "on" : "off"}  policy=${agents.webBotAuth.policy}` +
        `  keys=${agents.webBotAuth.staticKeys}  directories=[${agents.webBotAuth.directories.join(", ")}]`,
    );
    console.log(
      `  confirmation=${agents.confirmation.mode}  ttlSeconds=${agents.confirmation.ttlSeconds ?? "default"}` +
        `  singleUse=${agents.confirmation.singleUse}`,
    );
    console.log(
      `  mcp=${agents.mcp.enabled ? "on" : "off"}  endpoint=${agents.mcp.endpoint ?? "n/a"}`,
    );
    console.log(
      `  llmsTxt=${
        agents.llmsTxt.enabled === null
          ? "unknown (upgrade @pracht/vite-plugin)"
          : agents.llmsTxt.enabled
            ? "on"
            : "off"
      }`,
    );
    console.log(
      `  exposure  http=${agents.exposure.http}  webmcp=${agents.exposure.webmcp}` +
        `  mcp=${agents.exposure.mcp}  private=${agents.exposure.private}`,
    );

    if (agents.capabilities.length === 0) {
      console.log("  No capability operations registered.");
    } else {
      for (const capability of agents.capabilities) {
        const transports = formatCapabilityTransports(capability, report);
        console.log(
          `  ${capability.name}  effect=${capability.effect ?? "n/a"}  transports=${transports}  ` +
            `policy=${capability.agentPolicy ?? `${agents.webBotAuth.policy} (inherited)`}  ` +
            `http=${capability.httpPath ?? "n/a"}`,
        );
      }
    }

    printMcpInspectionStatus(report);

    // The one silent hole in the surface: exposure recorded in the graph that
    // nothing serves. `pracht verify` warns about it too; say it here as well,
    // because this is the command a reviewer runs to answer the question.
    if (agents.exposure.mcp > 0 && !agents.mcp.enabled) {
      console.log(
        "    ! capabilities set expose.mcp but agents.mcp is unconfigured — the exposure is " +
          "recorded and nothing serves it.",
      );
    }
  }

  if (report.build) {
    console.log("\nBuild");
    console.log(`  adapterTarget=${report.build.adapterTarget}`);
    console.log(`  clientEntryUrl=${report.build.clientEntryUrl ?? "null"}`);
    console.log(`  cssManifestKeys=${Object.keys(report.build.cssManifest).length}`);
    console.log(`  jsManifestKeys=${Object.keys(report.build.jsManifest).length}`);
  }
}
