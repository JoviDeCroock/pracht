import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { readClientBuildAssets } from "../build-metadata.js";
import { HTTP_METHODS } from "../constants.js";
import { readProjectConfig, resolveProjectPath } from "../project.js";

const INSPECT_TARGETS = new Set(["routes", "api", "build", "all"]);
const METHOD_ORDER = [...HTTP_METHODS];

export const inspectCommand = defineCommand({
  meta: {
    name: "inspect",
    description: "Inspect resolved app graph",
  },
  args: {
    target: {
      type: "positional",
      description: "What to inspect: routes, api, build, or all",
      required: false,
    },
    json: {
      type: "boolean",
      description: "Output results as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const target = args.target || "all";

    if (!INSPECT_TARGETS.has(target)) {
      throw new Error(`Unknown inspect target: ${target}`);
    }

    const report = await runInspect(process.cwd(), { target });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    printInspectReport(report);
  },
});

interface InspectReport {
  mode: string;
  routes?: SerializedRoute[];
  api?: ApiRoute[];
  build?: BuildInfo;
}

interface SerializedRoute {
  file: string;
  id: string;
  loaderFile: string | null;
  middleware: string[];
  path: string;
  render: string | null;
  revalidate: unknown;
  shell: string | null;
  shellFile: string | null;
}

interface ApiRoute {
  file: string;
  methods: string[];
  path: string;
}

interface BuildInfo {
  adapterTarget: string;
  clientEntryUrl: string | null;
  cssManifest: Record<string, string[]>;
  jsManifest: Record<string, string[]>;
}

export async function runInspect(
  root: string,
  { target = "all" }: { target?: string } = {},
): Promise<InspectReport> {
  const { createServer } = await import("vite");
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
    try {
      readFileSync(manifestPath, "utf-8");
    } catch {
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
      report.routes = serializeRoutes(serverModule.resolvedApp.routes);
    }

    if (target === "api" || target === "all") {
      report.api = await Promise.all(
        serverModule.apiRoutes.map(async (route: { file: string; path: string }) => ({
          file: route.file,
          methods: await detectApiMethods(server, root, route.file),
          path: route.path,
        })),
      );
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

interface RawRoute {
  file: string;
  id: string;
  loaderFile?: string;
  middleware: string[];
  path: string;
  render?: string;
  revalidate?: unknown;
  shell?: string;
  shellFile?: string;
}

function serializeRoutes(routes: RawRoute[]): SerializedRoute[] {
  return routes.map((route) => ({
    file: route.file,
    id: route.id,
    loaderFile: route.loaderFile ?? null,
    middleware: route.middleware,
    path: route.path,
    render: route.render ?? null,
    revalidate: route.revalidate ?? null,
    shell: route.shell ?? null,
    shellFile: route.shellFile ?? null,
  }));
}

async function detectApiMethods(
  server: { ssrLoadModule(id: string): Promise<Record<string, unknown>> },
  root: string,
  file: string,
): Promise<string[]> {
  const resolvedFile = resolve(root, `.${file}`);
  const source = readFileSync(resolvedFile, "utf-8");

  try {
    const module = await server.ssrLoadModule(file);
    return METHOD_ORDER.filter((method) => typeof module[method] === "function");
  } catch {
    return METHOD_ORDER.filter((method) =>
      new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`).test(source),
    );
  }
}

function printInspectReport(report: InspectReport): void {
  consola.box(`Pracht inspect (${report.mode} mode)`);

  if (report.routes) {
    consola.log("\nRoutes");
    for (const route of report.routes) {
      consola.info(
        `  ${route.path}  id=${route.id}  render=${route.render ?? "n/a"}  file=${route.file}`,
      );
    }
  }

  if (report.api) {
    consola.log("\nAPI");
    if (report.api.length === 0) {
      consola.info("  No API routes found.");
    } else {
      for (const route of report.api) {
        const methods = route.methods.length > 0 ? route.methods.join(",") : "none";
        consola.info(`  ${route.path}  methods=${methods}  file=${route.file}`);
      }
    }
  }

  if (report.build) {
    consola.log("\nBuild");
    consola.info(`  adapterTarget=${report.build.adapterTarget}`);
    consola.info(`  clientEntryUrl=${report.build.clientEntryUrl ?? "null"}`);
    consola.info(`  cssManifestKeys=${Object.keys(report.build.cssManifest).length}`);
    consola.info(`  jsManifestKeys=${Object.keys(report.build.jsManifest).length}`);
  }
}
