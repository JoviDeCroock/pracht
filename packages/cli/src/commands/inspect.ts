import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { serializeApiRoutes, serializeAppRoutes } from "@pracht/core";
import type { AppGraphApiRoute, AppGraphRoute, ResolvedApiRoute } from "@pracht/core";
import { defineCommand } from "citty";
import { createServer } from "vite";

import { handleCliError } from "../utils.js";
import { readClientBuildAssets } from "../build-metadata.js";
import { readProjectConfig, resolveProjectPath } from "../project.js";

const INSPECT_TARGETS = new Set(["routes", "api", "build", "all"]);

export default defineCommand({
  meta: {
    name: "inspect",
    description: "Inspect resolved app graph",
  },
  args: {
    target: {
      type: "positional",
      description: "Inspect target: routes, api, build, or all",
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
      handleCliError(new Error(`Unknown inspect target: ${target}`), {
        json: Boolean(args.json),
      });
    }

    const report = await runInspect(process.cwd(), { target });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    printInspectReport(report);
  },
});

export interface InspectReport {
  api?: AppGraphApiRoute[];
  build?: {
    adapterTarget: string;
    clientEntryUrl: string | null;
    cssManifest: Record<string, string[]>;
    jsManifest: Record<string, string[]>;
  };
  mode: string;
  routes?: AppGraphRoute[];
}

export async function runInspect(
  root: string,
  { inspectApiMethods = true, target = "all" } = {},
): Promise<InspectReport> {
  const project = readProjectConfig(root);

  if (!project.configFile) {
    throw new Error(
      "Missing vite config. `pracht inspect` requires a project with pracht configured.",
    );
  }

  if (!project.hasPrachtPlugin) {
    throw new Error("vite.config does not appear to register the pracht plugin.");
  }

  if (project.mode === "manifest") {
    const manifestPath = resolveProjectPath(project.root, project.appFile);
    if (!existsSync(manifestPath)) {
      throw new Error(`App manifest is missing at ${project.appFile}.`);
    }
  }

  const server = await createServer({
    root,
    logLevel: "silent",
    server: {
      middlewareMode: true,
    },
  });

  try {
    const serverModule = await server.ssrLoadModule("virtual:pracht/server");
    const report: InspectReport = {
      mode: project.mode,
    };

    if (target === "routes" || target === "all") {
      report.routes = serializeAppRoutes(serverModule.resolvedApp.routes);
    }

    if (target === "api" || target === "all") {
      report.api = inspectApiMethods
        ? await serializeApiRoutes(serverModule.apiRoutes, {
            loadModule: (file) => server.ssrLoadModule(file),
            readSource: (file) => readFileSync(resolve(root, `.${file}`), "utf-8"),
          })
        : (serverModule.apiRoutes as ResolvedApiRoute[]).map(({ file, path }) => ({
            file,
            methods: [],
            path,
          }));
    }

    if (target === "build" || target === "all") {
      const buildAssets = readClientBuildAssets(root);
      report.build = {
        adapterTarget: serverModule.buildTarget,
        clientEntryUrl: buildAssets.clientEntryUrl,
        cssManifest: buildAssets.cssManifest,
        jsManifest: buildAssets.jsManifest,
      };
    }

    return report;
  } finally {
    await server.close();
  }
}

function printInspectReport(report: InspectReport): void {
  console.log(`Pracht inspect (${report.mode} mode)`);

  if (report.routes) {
    console.log("\nRoutes");
    for (const route of report.routes) {
      console.log(
        `  ${route.path}  id=${route.id}  render=${route.render ?? "n/a"}  file=${route.file}`,
      );
    }
  }

  if (report.api) {
    console.log("\nAPI");
    if (report.api.length === 0) {
      console.log("  No API routes found.");
    } else {
      for (const route of report.api) {
        const methods = route.methods.length > 0 ? route.methods.join(",") : "none";
        console.log(`  ${route.path}  methods=${methods}  file=${route.file}`);
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
