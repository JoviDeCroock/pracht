import { describe, expect, it, vi } from "vitest";
import {
  isServerOnlyModuleFile,
  sendServerOnlyFullReload,
  type HotUpdateServerLike,
} from "../src/hot-update-reload.ts";

function createServer(graphs: Record<string, string[]>): {
  server: HotUpdateServerLike;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const environments: Record<string, unknown> = {};
  for (const [name, files] of Object.entries(graphs)) {
    environments[name] = {
      moduleGraph: {
        getModulesByFile: (file: string) =>
          files.includes(file) ? new Set([{ file }]) : undefined,
      },
      ...(name === "client" ? { hot: { send } } : {}),
    };
  }
  return { server: { environments } as HotUpdateServerLike, send };
}

const ROUTE = "/app/src/routes/static-page.tsx";

describe("isServerOnlyModuleFile", () => {
  it("flags files that only the SSR environment knows about", () => {
    const { server } = createServer({ client: [], ssr: [ROUTE] });
    expect(isServerOnlyModuleFile(server, ROUTE)).toBe(true);
  });

  it("leaves files in the client graph to client HMR", () => {
    const { server } = createServer({ client: [ROUTE], ssr: [ROUTE] });
    expect(isServerOnlyModuleFile(server, ROUTE)).toBe(false);
  });

  it("ignores files no environment has loaded", () => {
    const { server } = createServer({ client: [], ssr: [] });
    expect(isServerOnlyModuleFile(server, ROUTE)).toBe(false);
  });

  it("checks every non-client environment, not just ssr", () => {
    const { server } = createServer({ client: [], ssr: [], worker: [ROUTE] });
    expect(isServerOnlyModuleFile(server, ROUTE)).toBe(true);
  });

  it("stays inert without a client environment", () => {
    const { server } = createServer({ ssr: [ROUTE] });
    expect(isServerOnlyModuleFile(server, ROUTE)).toBe(false);
    expect(isServerOnlyModuleFile({}, ROUTE)).toBe(false);
  });
});

describe("sendServerOnlyFullReload", () => {
  it("reloads open pages for server-only files", () => {
    const { server, send } = createServer({ client: [], ssr: [ROUTE] });
    expect(sendServerOnlyFullReload(server, ROUTE)).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: "full-reload" });
  });

  it("sends nothing when the file has a client module", () => {
    const { server, send } = createServer({ client: [ROUTE], ssr: [ROUTE] });
    expect(sendServerOnlyFullReload(server, ROUTE)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
