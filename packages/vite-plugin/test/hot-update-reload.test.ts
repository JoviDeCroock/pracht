import { describe, expect, it, vi } from "vitest";
import {
  isServerOnlyModuleFile,
  sendServerOnlyFullReload,
  type HotUpdateServerLike,
} from "../src/hot-update-reload.ts";
import { pracht } from "../src/index.ts";
import { PRACHT_CLIENT_MODULE_ID } from "../src/plugin-assets.ts";

interface GraphEntry {
  file: string;
  type?: "js" | "css" | "asset";
}

// Vite never resolves or transforms the file-only entries it creates for plugin
// watch dependencies, so they carry an `/@fs/`-prefixed url and a null id. Real
// modules always carry a resolved id. Mirror both shapes so the fixture matches
// what the dev server actually hands `handleHotUpdate`.
function createModuleNode(entry: string | GraphEntry) {
  const { file, type = "js" } = typeof entry === "string" ? { file: entry } : entry;
  return type === "asset"
    ? { file, id: null, type, url: `/@fs/${file}` }
    : { file, id: file, type, url: file };
}

function createServer(graphs: Record<string, Array<string | GraphEntry>>): {
  server: HotUpdateServerLike;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const environments: Record<string, unknown> = {};
  for (const [name, entries] of Object.entries(graphs)) {
    environments[name] = {
      moduleGraph: {
        getModulesByFile: (file: string) => {
          const modules = entries.map(createModuleNode).filter((module) => module.file === file);
          return modules.length > 0 ? new Set(modules) : undefined;
        },
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

  it("ignores client file-only asset entries created by content scanners", () => {
    const { server } = createServer({
      client: [{ file: ROUTE, type: "asset" }],
      ssr: [ROUTE, { file: ROUTE, type: "asset" }],
    });
    expect(isServerOnlyModuleFile(server, ROUTE)).toBe(true);
  });

  it("leaves real client CSS modules to client HMR", () => {
    const { server } = createServer({
      client: [{ file: ROUTE, type: "css" }],
      ssr: [ROUTE],
    });
    expect(isServerOnlyModuleFile(server, ROUTE)).toBe(false);
  });

  it("ignores files no environment has loaded", () => {
    const { server } = createServer({ client: [], ssr: [] });
    expect(isServerOnlyModuleFile(server, ROUTE)).toBe(false);
  });

  it("ignores files represented only by file-only assets in every graph", () => {
    const { server } = createServer({
      client: [{ file: ROUTE, type: "asset" }],
      ssr: [{ file: ROUTE, type: "asset" }],
    });
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

describe("pracht handleHotUpdate", () => {
  it("invalidates generated client head hints when a shell changes", () => {
    const shell = "/app/src/shells/public.tsx";
    const clientModule = { id: PRACHT_CLIENT_MODULE_ID };
    const invalidateModule = vi.fn();
    const plugin = pracht().find((candidate) => candidate.name === "pracht");
    const handleHotUpdate = plugin?.handleHotUpdate;
    if (typeof handleHotUpdate !== "function") throw new Error("missing Pracht hot-update hook");

    handleHotUpdate.call(
      {} as never,
      {
        file: shell,
        server: {
          config: { root: "/app" },
          moduleGraph: {
            getModuleById: (id: string) =>
              id === PRACHT_CLIENT_MODULE_ID ? clientModule : undefined,
            invalidateModule,
          },
          environments: {
            client: {
              moduleGraph: {
                getModulesByFile: () => new Set([createModuleNode(shell)]),
              },
              hot: { send: vi.fn() },
            },
          },
        },
      } as never,
    );

    expect(invalidateModule).toHaveBeenCalledWith(clientModule);
  });
});
