import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { serializeApiRoutes, serializeAppRoutes, serializeCapabilities } from "@pracht/core";
import type {
  AppGraphApiRoute,
  AppGraphCapability,
  AppGraphRoute,
  ResolvedApiRoute,
} from "@pracht/core";

import { capabilityModuleLoader, createSourceReader } from "./app-graph.js";
import { withAppServer } from "./app-server.js";
import { readClientBuildAssets } from "./build-metadata.js";

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

export interface InspectOptions {
  inspectApiMethods?: boolean;
  target?: string | string[];
}

export async function runInspect(
  root: string,
  { inspectApiMethods = true, target = "all" }: InspectOptions = {},
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

function withEffectiveHydration(route: AppGraphRoute): InspectRoute {
  return { ...route, hydrationEffective: route.hydration ?? "full" };
}
