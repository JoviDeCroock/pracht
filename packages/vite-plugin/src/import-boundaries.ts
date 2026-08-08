import { resolve } from "node:path";
import type { Plugin } from "vite";

export const SERVER_ONLY_MODULE_ID = "@pracht/core/server-only";
export const CLIENT_ONLY_MODULE_ID = "@pracht/core/client-only";

type Boundary = "client-only" | "server-only";

/** Enforce explicit and filename-based boundaries between app server and client graphs. */
export function createImportBoundariesPlugin(enabled = true): Plugin {
  let root = normalizePath(resolve(process.cwd()));

  return {
    name: "pracht:import-boundaries",
    enforce: "pre",

    configResolved(config) {
      root = normalizePath(resolve(config.root));
    },

    async resolveId(source, importer, options) {
      if (!enabled || (options as { scan?: boolean } | undefined)?.scan) return null;

      const target = targetConsumer(this, options?.ssr);
      const marker = markerBoundary(source);
      if (marker) {
        assertAllowed(marker, target, source, importer);
        return null;
      }

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const resolvedId = normalizePath((resolved?.id ?? source).split("?")[0]);
      if (!isInsideRoot(resolvedId, root)) return null;

      const boundary = filenameBoundary(resolvedId);
      if (boundary) assertAllowed(boundary, target, resolvedId, importer);
      return null;
    },
  };
}

export function filenameBoundary(id: string): Boundary | null {
  const filename = normalizePath(id).split("?")[0].split("/").pop() ?? "";
  if (/\.server(?:\.|$)/.test(filename)) return "server-only";
  if (/\.client(?:\.|$)/.test(filename)) return "client-only";
  return null;
}

function markerBoundary(source: string): Boundary | null {
  if (source === SERVER_ONLY_MODULE_ID) return "server-only";
  if (source === CLIENT_ONLY_MODULE_ID) return "client-only";
  return null;
}

function targetConsumer(
  context: { environment?: { config?: { consumer?: string } } },
  ssr: boolean | undefined,
): "client" | "server" {
  const consumer = context.environment?.config?.consumer;
  if (consumer === "client" || consumer === "server") return consumer;
  return ssr ? "server" : "client";
}

function assertAllowed(
  boundary: Boundary,
  target: "client" | "server",
  source: string,
  importer: string | undefined,
): void {
  const invalid =
    (boundary === "server-only" && target === "client") ||
    (boundary === "client-only" && target === "server");
  if (!invalid) return;

  throw new Error(
    `[pracht] Import boundary violation: ${JSON.stringify(source)} is ${boundary} but was imported by ` +
      `${JSON.stringify(importer ?? "an entry module")} for the ${target} graph. ` +
      `Move the import to ${boundary === "server-only" ? "a loader, middleware, API route, or .server.* module" : "a browser-only entry or a client-side effect"}.`,
  );
}

function isInsideRoot(id: string, root: string): boolean {
  return !id.includes("/node_modules/") && (id === root || id.startsWith(`${root}/`));
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/$/, "");
}
