import { describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";

import { loadAppMetadataModule } from "../src/app-graph.ts";

function fakeServer(modules: Record<string, unknown>): ViteDevServer {
  return {
    ssrLoadModule: vi.fn(async (id: string) => {
      if (!(id in modules)) {
        const error = new Error(
          `Failed to load url ${id} (resolved id: ${id}). Does the file exist?`,
        );
        Object.assign(error, { code: "ERR_LOAD_URL" });
        throw error;
      }
      if (modules[id] instanceof Error) throw modules[id];
      return modules[id] as Record<string, unknown>;
    }),
  } as unknown as ViteDevServer;
}

describe("loadAppMetadataModule", () => {
  // The Cloudflare adapter re-exports Durable Objects (which import
  // `cloudflare:workers`) from the server entry — unresolvable in Vite's Node
  // SSR environment, so graph-reading commands must not touch that entry.
  it("reads the adapter-neutral dev metadata module", async () => {
    const server = fakeServer({
      "virtual:pracht/dev-metadata": { buildTarget: "cloudflare" },
      "virtual:pracht/server": { buildTarget: "should-not-be-read" },
    });

    await expect(loadAppMetadataModule(server)).resolves.toMatchObject({
      buildTarget: "cloudflare",
    });
    expect(server.ssrLoadModule).toHaveBeenCalledTimes(1);
  });

  it("falls back to the server entry for older vite-plugin versions", async () => {
    const server = fakeServer({ "virtual:pracht/server": { buildTarget: "node" } });

    await expect(loadAppMetadataModule(server)).resolves.toMatchObject({
      buildTarget: "node",
    });
  });

  it("does not mask an app error from the metadata module", async () => {
    const server = fakeServer({
      "virtual:pracht/dev-metadata": new Error('Unknown middleware "atu" for route "/".'),
      "virtual:pracht/server": new Error("Cannot find module 'cloudflare:workers'"),
    });

    await expect(loadAppMetadataModule(server)).rejects.toThrow(
      'Unknown middleware "atu" for route "/".',
    );
    expect(server.ssrLoadModule).toHaveBeenCalledTimes(1);
  });

  it("surfaces the app's own load error when neither module loads", async () => {
    await expect(loadAppMetadataModule(fakeServer({}))).rejects.toThrow(
      "Failed to load url virtual:pracht/server",
    );
  });
});
