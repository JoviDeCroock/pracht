import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

interface TestModuleNode {
  file: string;
  id: string | null;
  importers: Set<TestModuleNode>;
  type: "js" | "css" | "asset";
  url: string;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { force: true, recursive: true });
  }
});

// Vite never resolves or transforms the file-only entries it creates for plugin
// watch dependencies, so they carry an `/@fs/`-prefixed url and a null id. Real
// modules always carry a resolved id. Mirror both shapes so the fixture matches
// what the dev server actually hands `handleHotUpdate`.
function createModuleNode(entry: string | GraphEntry): TestModuleNode {
  const { file, type = "js" } = typeof entry === "string" ? { file: entry } : entry;
  return type === "asset"
    ? { file, id: null, importers: new Set(), type, url: `/@fs/${file}` }
    : { file, id: file, importers: new Set(), type, url: file };
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
  it.each(["add", "remove"] as const)(
    "reloads generated client head state when a shell %ss head()",
    async (operation) => {
      const root = mkdtempSync(join(tmpdir(), "pracht-head-hmr-"));
      tempDirs.push(root);
      mkdirSync(join(root, "src", "routes"), { recursive: true });
      mkdirSync(join(root, "src", "shells"), { recursive: true });
      writeFileSync(join(root, "src", "routes.ts"), "export const app = {};\n");
      const shell = join(root, "src", "shells", "public.tsx");
      const headSource =
        "export function head() { return { fonts: [] }; }\nexport function Shell() { return null; }\n";
      const headlessSource = "export function Shell() { return null; }\n";
      writeFileSync(shell, operation === "add" ? headlessSource : headSource);

      const plugin = pracht().find((candidate) => candidate.name === "pracht");
      const configResolved = plugin?.configResolved;
      const load = plugin?.load;
      const handleHotUpdate = plugin?.handleHotUpdate;
      if (
        typeof configResolved !== "function" ||
        typeof load !== "function" ||
        typeof handleHotUpdate !== "function"
      ) {
        throw new Error("missing Pracht development hooks");
      }
      configResolved.call({} as never, { command: "serve", root } as never);
      await load.call({} as never, PRACHT_CLIENT_MODULE_ID);
      writeFileSync(shell, operation === "add" ? headSource : headlessSource);

      const shellModule = createModuleNode(shell);
      const clientModule = { id: PRACHT_CLIENT_MODULE_ID };
      const invalidateModule = vi.fn();
      const result = await handleHotUpdate.call(
        {} as never,
        {
          file: shell,
          modules: [shellModule],
          server: {
            config: { root },
            moduleGraph: {
              getModuleById: (id: string) =>
                id === PRACHT_CLIENT_MODULE_ID ? clientModule : undefined,
              invalidateModule,
            },
            environments: {
              client: {
                moduleGraph: {
                  getModulesByFile: () => new Set([shellModule]),
                },
                hot: { send: vi.fn() },
              },
            },
          },
        } as never,
      );

      expect(invalidateModule).toHaveBeenCalledWith(clientModule);
      expect(result).toEqual([shellModule, clientModule]);
    },
  );

  it("reloads generated head state when a shared font dependency changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-head-dependency-hmr-"));
    tempDirs.push(root);
    mkdirSync(join(root, "src", "routes"), { recursive: true });
    mkdirSync(join(root, "src", "shells"), { recursive: true });
    writeFileSync(join(root, "src", "routes.ts"), "export const app = {};\n");
    const fontFile = join(root, "src", "fonts.ts");
    const shell = join(root, "src", "shells", "public.tsx");
    writeFileSync(fontFile, "export const inter = {};\n");
    writeFileSync(
      shell,
      'import { inter } from "../fonts";\nexport function head() { return { fonts: [inter] }; }\nexport function Shell() { return null; }\n',
    );

    const plugin = pracht().find((candidate) => candidate.name === "pracht");
    const configResolved = plugin?.configResolved;
    const load = plugin?.load;
    const handleHotUpdate = plugin?.handleHotUpdate;
    if (
      typeof configResolved !== "function" ||
      typeof load !== "function" ||
      typeof handleHotUpdate !== "function"
    ) {
      throw new Error("missing Pracht development hooks");
    }
    configResolved.call({} as never, { command: "serve", root } as never);
    await load.call({} as never, PRACHT_CLIENT_MODULE_ID);

    const fontModule = createModuleNode(fontFile);
    const shellModule = createModuleNode(shell);
    fontModule.importers.add(shellModule);
    const clientModule = { id: PRACHT_CLIENT_MODULE_ID };
    const invalidateModule = vi.fn();
    const result = await handleHotUpdate.call(
      {} as never,
      {
        file: fontFile,
        modules: [fontModule],
        server: {
          config: { root },
          moduleGraph: {
            getModuleById: (id: string) =>
              id === PRACHT_CLIENT_MODULE_ID ? clientModule : undefined,
            invalidateModule,
          },
          environments: {
            client: {
              moduleGraph: {
                getModulesByFile: () => new Set([fontModule]),
              },
              hot: { send: vi.fn() },
            },
          },
        },
      } as never,
    );

    expect(invalidateModule).toHaveBeenCalledWith(clientModule);
    expect(result).toEqual([fontModule, clientModule]);
  });

  it("reloads document headers when a shared policy dependency changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-headers-dependency-hmr-"));
    tempDirs.push(root);
    mkdirSync(join(root, "src", "routes"), { recursive: true });
    mkdirSync(join(root, "src", "shells"), { recursive: true });
    writeFileSync(join(root, "src", "routes.ts"), "export const app = {};\n");
    const policyFile = join(root, "src", "policy.ts");
    const route = join(root, "src", "routes", "home.tsx");
    writeFileSync(
      policyFile,
      'export function headers() { return { "content-security-policy": "default-src self" }; }\n',
    );
    writeFileSync(
      route,
      'export { headers } from "../policy";\nexport function Component() { return null; }\n',
    );

    const plugin = pracht().find((candidate) => candidate.name === "pracht");
    const configResolved = plugin?.configResolved;
    const load = plugin?.load;
    const handleHotUpdate = plugin?.handleHotUpdate;
    if (
      typeof configResolved !== "function" ||
      typeof load !== "function" ||
      typeof handleHotUpdate !== "function"
    ) {
      throw new Error("missing Pracht development hooks");
    }
    configResolved.call({} as never, { command: "serve", root } as never);
    await load.call({} as never, PRACHT_CLIENT_MODULE_ID);

    const policyModule = createModuleNode(policyFile);
    const routeModule = createModuleNode(route);
    policyModule.importers.add(routeModule);
    const clientModule = { id: PRACHT_CLIENT_MODULE_ID };
    const result = await handleHotUpdate.call(
      {} as never,
      {
        file: policyFile,
        modules: [policyModule],
        server: {
          config: { root },
          moduleGraph: {
            getModuleById: (id: string) =>
              id === PRACHT_CLIENT_MODULE_ID ? clientModule : undefined,
            invalidateModule: vi.fn(),
          },
          environments: {
            client: {
              moduleGraph: { getModulesByFile: () => new Set([policyModule]) },
              hot: { send: vi.fn() },
            },
          },
        },
      } as never,
    );

    expect(result).toEqual([policyModule, clientModule]);
  });
});

describe("pracht handleHotUpdate route data staleness", () => {
  async function editRoute(routeSource: string, editedSource: string) {
    const root = mkdtempSync(join(tmpdir(), "pracht-route-data-hmr-"));
    tempDirs.push(root);
    mkdirSync(join(root, "src", "routes"), { recursive: true });
    mkdirSync(join(root, "src", "shells"), { recursive: true });
    writeFileSync(join(root, "src", "routes.ts"), "export const app = {};\n");
    const routeFile = join(root, "src", "routes", "home.tsx");
    writeFileSync(routeFile, routeSource);

    const plugin = pracht().find((candidate) => candidate.name === "pracht");
    const configResolved = plugin?.configResolved;
    const load = plugin?.load;
    const handleHotUpdate = plugin?.handleHotUpdate;
    if (
      typeof configResolved !== "function" ||
      typeof load !== "function" ||
      typeof handleHotUpdate !== "function"
    ) {
      throw new Error("missing Pracht development hooks");
    }
    configResolved.call({} as never, { command: "serve", root } as never);
    await load.call({} as never, PRACHT_CLIENT_MODULE_ID);
    writeFileSync(routeFile, editedSource);

    const routeModule = createModuleNode(routeFile);
    const clientModule = { id: PRACHT_CLIENT_MODULE_ID };
    const send = vi.fn();
    const result = await handleHotUpdate.call(
      {} as never,
      {
        file: routeFile,
        modules: [routeModule],
        server: {
          config: { root },
          moduleGraph: {
            getModuleById: (id: string) =>
              id === PRACHT_CLIENT_MODULE_ID ? clientModule : undefined,
            invalidateModule: vi.fn(),
          },
          environments: {
            client: {
              moduleGraph: { getModulesByFile: () => new Set([routeModule]) },
              hot: { send },
            },
          },
        },
      } as never,
    );

    return { clientModule, result, routeModule, send };
  }

  const WITH_HEAD =
    'export function head() { return { title: "a" }; }\n' +
    "export async function loader() { return { n: 1 }; }\n" +
    "export function Component() { return null; }\n";
  const WITH_HEADERS =
    'export function headers() { return { "content-security-policy": "default-src self" }; }\n' +
    "export function Component() { return null; }\n";

  // The regression this guards: on main every edit to a head-bearing route
  // returned the client entry, which is not a Fast Refresh boundary, so Vite
  // full-reloaded. Reloading is what used to deliver the new loader output.
  it("keeps an edit to a head-bearing route out of the client entry", async () => {
    const { result } = await editRoute(WITH_HEAD, WITH_HEAD.replace("return null", "return 1"));

    expect(result).toBeUndefined();
  });

  // A route module's loader is stripped out of the browser copy, so patching
  // the component in place leaves the page holding data the server would no
  // longer send. The client entry listens for this and re-fetches route state.
  it("tells open pages their route data is stale", async () => {
    const { send } = await editRoute(WITH_HEAD, WITH_HEAD.replace("n: 1", "n: 2"));

    expect(send).toHaveBeenCalledWith({
      type: "custom",
      event: "pracht:route-data-stale",
    });
  });

  it("refreshes data when a client-reachable loader dependency changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-loader-dependency-hmr-"));
    tempDirs.push(root);
    mkdirSync(join(root, "src", "routes"), { recursive: true });
    mkdirSync(join(root, "src", "shells"), { recursive: true });
    writeFileSync(join(root, "src", "routes.ts"), "export const app = {};\n");
    const sharedFile = join(root, "src", "shared.ts");
    const routeFile = join(root, "src", "routes", "home.tsx");
    writeFileSync(sharedFile, "export const greeting = 'old';\n");
    writeFileSync(
      routeFile,
      'import { greeting } from "../shared";\n' +
        "export function loader() { return { greeting }; }\n" +
        "export function Component() { return greeting; }\n",
    );

    const plugin = pracht().find((candidate) => candidate.name === "pracht");
    const configResolved = plugin?.configResolved;
    const load = plugin?.load;
    const handleHotUpdate = plugin?.handleHotUpdate;
    if (
      typeof configResolved !== "function" ||
      typeof load !== "function" ||
      typeof handleHotUpdate !== "function"
    ) {
      throw new Error("missing Pracht development hooks");
    }
    configResolved.call({} as never, { command: "serve", root } as never);
    await load.call({} as never, PRACHT_CLIENT_MODULE_ID);

    const sharedModule = createModuleNode(sharedFile);
    const routeModule = createModuleNode(routeFile);
    sharedModule.importers.add(routeModule);
    const send = vi.fn();
    const result = await handleHotUpdate.call(
      {} as never,
      {
        file: sharedFile,
        modules: [sharedModule],
        server: {
          config: { root },
          moduleGraph: {
            getModuleById: () => undefined,
            invalidateModule: vi.fn(),
          },
          environments: {
            client: {
              moduleGraph: { getModulesByFile: () => new Set([sharedModule]) },
              hot: { send },
            },
          },
        },
      } as never,
    );

    expect(result).toBeUndefined();
    expect(send).toHaveBeenCalledWith({
      type: "custom",
      event: "pracht:route-data-stale",
    });
    expect(send).not.toHaveBeenCalledWith({ type: "full-reload" });
  });

  it("refreshes data when a client-reachable dependency feeds a separate loader", async () => {
    const root = mkdtempSync(join(tmpdir(), "pracht-separate-loader-dependency-hmr-"));
    tempDirs.push(root);
    mkdirSync(join(root, "src", "routes"), { recursive: true });
    mkdirSync(join(root, "src", "server"), { recursive: true });
    mkdirSync(join(root, "src", "shells"), { recursive: true });
    writeFileSync(join(root, "src", "routes.ts"), "export const app = {};\n");
    const sharedFile = join(root, "src", "shared.ts");
    const routeFile = join(root, "src", "routes", "home.tsx");
    const loaderFile = join(root, "src", "server", "home-loader.ts");
    writeFileSync(sharedFile, "export const greeting = 'old';\n");
    writeFileSync(
      routeFile,
      'import { greeting } from "../shared";\n' +
        "export function Component() { return greeting; }\n",
    );
    writeFileSync(
      loaderFile,
      'import { greeting } from "../shared";\n' +
        "export function loader() { return { greeting }; }\n",
    );

    const plugin = pracht().find((candidate) => candidate.name === "pracht");
    const configResolved = plugin?.configResolved;
    const load = plugin?.load;
    const handleHotUpdate = plugin?.handleHotUpdate;
    if (
      typeof configResolved !== "function" ||
      typeof load !== "function" ||
      typeof handleHotUpdate !== "function"
    ) {
      throw new Error("missing Pracht development hooks");
    }
    configResolved.call({} as never, { command: "serve", root } as never);
    await load.call({} as never, PRACHT_CLIENT_MODULE_ID);

    const sharedModule = createModuleNode(sharedFile);
    const routeModule = createModuleNode(routeFile);
    const loaderModule = createModuleNode(loaderFile);
    sharedModule.importers.add(routeModule);
    sharedModule.importers.add(loaderModule);
    const send = vi.fn();
    const result = await handleHotUpdate.call(
      {} as never,
      {
        file: sharedFile,
        modules: [sharedModule],
        server: {
          config: { root },
          moduleGraph: {
            getModuleById: () => undefined,
            invalidateModule: vi.fn(),
          },
          environments: {
            client: {
              moduleGraph: { getModulesByFile: () => new Set([sharedModule]) },
              hot: { send },
            },
          },
        },
      } as never,
    );

    expect(result).toBeUndefined();
    expect(send).toHaveBeenCalledWith({
      type: "custom",
      event: "pracht:route-data-stale",
    });
    expect(send).not.toHaveBeenCalledWith({ type: "full-reload" });
  });

  it("reloads when an edited route owns document response headers", async () => {
    const { clientModule, result, routeModule, send } = await editRoute(
      WITH_HEADERS,
      WITH_HEADERS.replace("return null", "return 1"),
    );

    expect(result).toEqual([routeModule, clientModule]);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "pracht:route-data-stale" }),
    );
  });

  it.each([
    ["gains", false],
    ["loses", true],
  ])("reloads the client entry when a route %s a loader", async (_label, startsWithLoader) => {
    const withoutLoader = "export function Component() { return null; }\n";
    const withLoader = "export async function loader() { return { n: 1 }; }\n" + withoutLoader;
    const { clientModule, result, routeModule, send } = await editRoute(
      startsWithLoader ? withLoader : withoutLoader,
      startsWithLoader ? withoutLoader : withLoader,
    );

    expect(result).toEqual([routeModule, clientModule]);
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "pracht:route-data-stale" }),
    );
  });

  // A reload re-fetches everything on its own; asking for a revalidation on
  // top of it would be a second request for data the new document already has.
  it("stays quiet when the edit already reloads the document", async () => {
    const { result, send } = await editRoute(
      "export function Component() { return null; }\n",
      WITH_HEAD,
    );

    expect(result).toBeDefined();
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "pracht:route-data-stale" }),
    );
  });
});
