import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { serializeApiRoutes, serializeAppRoutes, serializeCapabilities } from "@pracht/core";
import type {
  AppGraphApiRoute,
  AppGraphCapability,
  AppGraphRoute,
  ResolvedApiRoute,
} from "@pracht/core";
import { defineCommand } from "citty";

import { capabilityModuleLoader, createSourceReader } from "../app-graph.js";
import { withAppServer } from "../app-server.js";
import { handleCliError } from "../utils.js";
import { readClientBuildAssets } from "../build-metadata.js";

const INSPECT_TARGETS = new Set(["routes", "api", "capabilities", "build", "all"]);

export default defineCommand({
  meta: {
    name: "inspect",
    description: "Inspect resolved app graph",
  },
  args: {
    target: {
      type: "positional",
      description: "Inspect target: routes, api, capabilities, build, or all",
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

export interface InspectReport {
  api?: AppGraphApiRoute[];
  capabilities?: AppGraphCapability[];
  build?: {
    adapterTarget: string;
    clientEntryUrl: string | null;
    cssManifest: Record<string, string[]>;
    jsManifest: Record<string, string[]>;
  };
  mode: string;
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

    if (wants("capabilities")) {
      report.capabilities = await serializeCapabilities(
        serverModule.resolvedApp.capabilities,
        {
          loadModule: capabilityModuleLoader(server, serverModule),
          readSource: createSourceReader(root, project.appFile),
        },
        { strict: true },
      );
    }

    if (wants("build")) {
      const buildAssets = readClientBuildAssets(root);
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
        const transports =
          capability.transports.length > 0 ? capability.transports.join(",") : "private";
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
  }

  if (report.build) {
    console.log("\nBuild");
    console.log(`  adapterTarget=${report.build.adapterTarget}`);
    console.log(`  clientEntryUrl=${report.build.clientEntryUrl ?? "null"}`);
    console.log(`  cssManifestKeys=${Object.keys(report.build.cssManifest).length}`);
    console.log(`  jsManifestKeys=${Object.keys(report.build.jsManifest).length}`);
  }
}
