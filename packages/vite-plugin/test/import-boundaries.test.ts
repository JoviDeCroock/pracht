import type { Plugin } from "vite";
import { describe, expect, it, vi } from "vitest";

import {
  CLIENT_ONLY_MODULE_ID,
  SERVER_ONLY_MODULE_ID,
  createImportBoundariesPlugin,
  filenameBoundary,
} from "../src/import-boundaries.ts";
import { pracht } from "../src/index.ts";

function getHook<T>(plugin: Plugin, name: keyof Plugin): T {
  const hook = plugin[name] as unknown as T | { handler: T };
  return typeof hook === "object" && hook !== null && "handler" in hook ? hook.handler : hook;
}

type ResolveIdHook = (
  this: {
    environment?: { config?: { consumer?: string } };
    resolve: ReturnType<typeof vi.fn>;
  },
  source: string,
  importer: string | undefined,
  options?: { scan?: boolean; ssr?: boolean },
) => Promise<unknown>;

function context(consumer: "client" | "server", resolvedId?: string) {
  return {
    environment: { config: { consumer } },
    resolve: vi.fn(async () => (resolvedId ? { id: resolvedId } : null)),
  };
}

describe("import boundaries", () => {
  it("classifies filename conventions", () => {
    expect(filenameBoundary("/app/src/db.server.ts")).toBe("server-only");
    expect(filenameBoundary("/app/src/chart.client.tsx?import")).toBe("client-only");
    expect(filenameBoundary("/app/src/server.ts")).toBeNull();
  });

  it("rejects server-only files from client graphs", async () => {
    const resolveId = getHook<ResolveIdHook>(createImportBoundariesPlugin(), "resolveId");
    const resolvedId = `${process.cwd()}/src/session.server.ts`;

    await expect(
      resolveId.call(context("client", resolvedId), "./session.server.ts", "/app/src/widget.tsx"),
    ).rejects.toThrowError(/Import boundary violation.*server-only.*client graph/);
  });

  it("rejects client-only files from server graphs", async () => {
    const resolveId = getHook<ResolveIdHook>(createImportBoundariesPlugin(), "resolveId");
    const resolvedId = `${process.cwd()}/src/editor.client.tsx`;

    await expect(
      resolveId.call(context("server", resolvedId), "./editor.client.tsx", "/app/src/loader.ts"),
    ).rejects.toThrowError(/Import boundary violation.*client-only.*server graph/);
  });

  it("enforces explicit marker imports and permits the matching graph", async () => {
    const resolveId = getHook<ResolveIdHook>(createImportBoundariesPlugin(), "resolveId");

    await expect(
      resolveId.call(context("client"), SERVER_ONLY_MODULE_ID, "/app/src/secrets.ts"),
    ).rejects.toThrowError(/server-only.*client graph/);
    await expect(
      resolveId.call(context("server"), CLIENT_ONLY_MODULE_ID, "/app/src/widget.tsx"),
    ).rejects.toThrowError(/client-only.*server graph/);
    await expect(
      resolveId.call(context("server"), SERVER_ONLY_MODULE_ID, "/app/src/secrets.ts"),
    ).resolves.toBeNull();
    await expect(
      resolveId.call(context("client"), CLIENT_ONLY_MODULE_ID, "/app/src/widget.tsx"),
    ).resolves.toBeNull();
  });

  it("skips dependency scanning and can be disabled", async () => {
    const scanning = context("client", `${process.cwd()}/src/session.server.ts`);
    const resolveId = getHook<ResolveIdHook>(createImportBoundariesPlugin(), "resolveId");
    await expect(
      resolveId.call(scanning, "./session.server.ts", "/app/src/route.tsx", { scan: true }),
    ).resolves.toBeNull();
    expect(scanning.resolve).not.toHaveBeenCalled();

    const disabled = context("client", `${process.cwd()}/src/session.server.ts`);
    const disabledResolve = getHook<ResolveIdHook>(
      createImportBoundariesPlugin(false),
      "resolveId",
    );
    await expect(
      disabledResolve.call(disabled, "./session.server.ts", "/app/src/widget.tsx"),
    ).resolves.toBeNull();
  });

  it("is enabled in the framework plugin by default", () => {
    expect(pracht().some((plugin) => plugin.name === "pracht:import-boundaries")).toBe(true);
  });
});
