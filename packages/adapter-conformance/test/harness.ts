// The conformance harness: one fixture app and one static output directory,
// mounted on every adapter's request handler (and the dev middleware) behind
// the same `fetch(path, init)` interface. Node-shaped targets run behind a
// real `node:http` server so body limits and client disconnects are real;
// Web-native targets are called with a `Request` directly.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defineCapability } from "@pracht/capabilities";
import {
  defineApp,
  resolveApiRoutes,
  resolveApp,
  route,
  timeRevalidate,
  webhookRevalidate,
  type ModuleRegistry,
} from "@pracht/core";
import * as frameworkServer from "@pracht/core/server";
import type { ViteDevServer } from "vite";

import { createCloudflareFetchHandler } from "../../adapter-cloudflare/src/runtime.ts";
import { createNetlifyHandler } from "../../adapter-netlify/src/index.ts";
import { createNodeRequestHandler } from "../../adapter-node/src/index.ts";
import { createStaticPreviewHandler } from "../../adapter-static/src/index.ts";
import {
  createVercelEdgeHandler,
  createVercelNodeListener,
  type VercelExecutionContext,
} from "../../adapter-vercel/src/index.ts";
import { PRACHT_SERVER_MODULE_ID } from "../../vite-plugin/src/plugin-assets.ts";
import { createDevSSRMiddleware } from "../../vite-plugin/src/plugin-dev-ssr.ts";

export const TARGETS = [
  "node",
  "cloudflare",
  "netlify",
  "vercel-edge",
  "vercel-node",
  "static-preview",
  "dev",
] as const;
export type TargetId = (typeof TARGETS)[number];

export const REVALIDATE_TOKEN = "conformance-token";
/** Request bodies above this many bytes answer 413 on targets that read the body. */
export const MAX_BODY_SIZE = 1024;
/** How long a probe waits for an abort before recording that none arrived. */
export const ABORT_WAIT_MS = 1_500;

// ---------------------------------------------------------------------------
// The fixture app
// ---------------------------------------------------------------------------

/** What application code observed during one request. */
export interface Probe {
  loaderAborted?: boolean;
  capabilityAborted?: boolean;
  loaderStarted: Promise<void>;
  capabilityStarted: Promise<void>;
  loaderSettled: Promise<boolean>;
  capabilitySettled: Promise<boolean>;
}

function createProbe(): Probe & {
  startLoader(): void;
  startCapability(): void;
  settleLoader(aborted: boolean): void;
  settleCapability(aborted: boolean): void;
} {
  let startLoader!: () => void;
  let startCapability!: () => void;
  let settleLoader!: (aborted: boolean) => void;
  let settleCapability!: (aborted: boolean) => void;
  const probe = {
    loaderStarted: new Promise<void>((resolve) => (startLoader = resolve)),
    capabilityStarted: new Promise<void>((resolve) => (startCapability = resolve)),
    loaderSettled: new Promise<boolean>((resolve) => (settleLoader = resolve)),
    capabilitySettled: new Promise<boolean>((resolve) => (settleCapability = resolve)),
    startLoader: () => startLoader(),
    startCapability: () => startCapability(),
    settleLoader: (aborted: boolean) => {
      probe.loaderAborted = aborted;
      settleLoader(aborted);
    },
    settleCapability: (aborted: boolean) => {
      probe.capabilityAborted = aborted;
      settleCapability(aborted);
    },
  } as Probe & {
    startLoader(): void;
    startCapability(): void;
    settleLoader(aborted: boolean): void;
    settleCapability(aborted: boolean): void;
  };
  return probe;
}

/** Resolves `true` when `signal` aborts within {@link ABORT_WAIT_MS}, `false` otherwise. */
function waitForAbort(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ABORT_WAIT_MS);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** The document headers every ISG render of `/isg` produces. */
export const ISG_RENDER_HEADERS = {
  "cache-control": "public, max-age=30",
  "x-custom": "one",
  // Secret-shaped: a shared snapshot must never replay it.
  "x-api-token": "s3cret",
};

export const ISG_PATHS = {
  /** time + webhook policy; renders {@link ISG_RENDER_HEADERS}. */
  page: "/isg",
  /** time only; its render sets a cookie. */
  cookie: "/isg-cookie",
  /** time only; its render is `Cache-Control: private`. */
  private: "/isg-private",
  /** time only; a dynamic route at a path the build writes percent-encoded. */
  escaped: "/isg-posts/caf%C3%A9",
} as const;

export interface Fixture {
  /** Which build this is; every render's HTML names it. */
  build: string;
  app: ReturnType<typeof defineApp>;
  registry: ModuleRegistry;
  apiRoutes: ReturnType<typeof resolveApiRoutes>;
  isgManifest: Record<string, frameworkServer.ISGManifestEntry>;
  probe: Probe;
  /** Number of ISG renders this build ran, by path. */
  renders: Map<string, number>;
}

export function createFixture(options: { build?: string; generatedAt?: number } = {}): Fixture {
  const build = options.build ?? "A";
  const generatedAt = options.generatedAt ?? Date.now() - 3_600_000;
  const probe = createProbe();
  const renders = new Map<string, number>();
  const countRender = (path: string) => renders.set(path, (renders.get(path) ?? 0) + 1);

  const app = defineApp({
    routes: [
      route("/", "./routes/home.tsx", { render: "ssr" }),
      route("/slow", "./routes/slow.tsx", { render: "ssr" }),
      route(ISG_PATHS.page, "./routes/isg.tsx", {
        render: "isg",
        revalidate: [timeRevalidate(60), webhookRevalidate()],
      }),
      route(ISG_PATHS.cookie, "./routes/isg-cookie.tsx", {
        render: "isg",
        revalidate: timeRevalidate(60),
      }),
      route(ISG_PATHS.private, "./routes/isg-private.tsx", {
        render: "isg",
        revalidate: timeRevalidate(60),
      }),
      route("/isg-posts/:slug", "./routes/isg-post.tsx", {
        render: "isg",
        revalidate: timeRevalidate(60),
      }),
    ],
    capabilities: { "x.slow": "./capabilities/slow.ts" },
  });

  const slowCapability = defineCapability({
    title: "Slow",
    description: "Waits until its caller disconnects.",
    effect: "read",
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: {} },
    expose: { http: true },
    async run({ signal }) {
      probe.startCapability();
      probe.settleCapability(await waitForAbort(signal));
      return {};
    },
  });

  const registry: ModuleRegistry = {
    routeModules: {
      "./routes/home.tsx": async () => ({ Component: () => `home:${build}` }),
      "./routes/slow.tsx": async () => ({
        Component: () => "slow",
        loader: async ({ signal }: { signal: AbortSignal }) => {
          probe.startLoader();
          probe.settleLoader(await waitForAbort(signal));
          return {};
        },
      }),
      "./routes/isg.tsx": async () => ({
        Component: () => `render-of:${build}`,
        loader: async () => {
          countRender(ISG_PATHS.page);
          return {};
        },
        headers: () => ISG_RENDER_HEADERS,
      }),
      "./routes/isg-cookie.tsx": async () => ({
        Component: () => `render-of:${build}`,
        loader: async () => {
          countRender(ISG_PATHS.cookie);
          return {};
        },
        headers: () => ({ "set-cookie": "visitor=1; Path=/" }),
      }),
      "./routes/isg-private.tsx": async () => ({
        Component: () => `render-of:${build}`,
        loader: async () => {
          countRender(ISG_PATHS.private);
          return {};
        },
        headers: () => ({ "cache-control": "private, max-age=0" }),
      }),
      "./routes/isg-post.tsx": async () => ({
        Component: () => `render-of:${build}`,
        loader: async () => {
          countRender(ISG_PATHS.escaped);
          return {};
        },
      }),
    },
    apiModules: {
      "/src/api/echo.ts": async () => ({
        POST: async ({ request }: { request: Request }) =>
          new Response(await request.text(), { headers: { "content-type": "text/plain" } }),
      }),
    },
    capabilityModules: {
      "./capabilities/slow.ts": (async () => ({ default: slowCapability })) as NonNullable<
        ModuleRegistry["capabilityModules"]
      >[string],
    },
  } as ModuleRegistry;

  return {
    build,
    app,
    registry,
    apiRoutes: resolveApiRoutes(["/src/api/echo.ts"]),
    isgManifest: {
      [ISG_PATHS.page]: { revalidate: [timeRevalidate(60), webhookRevalidate()], generatedAt },
      [ISG_PATHS.cookie]: { revalidate: timeRevalidate(60), generatedAt },
      [ISG_PATHS.private]: { revalidate: timeRevalidate(60), generatedAt },
      [ISG_PATHS.escaped]: { revalidate: timeRevalidate(60), generatedAt },
    },
    probe,
    renders,
  };
}

// ---------------------------------------------------------------------------
// The static output directory (`dist/client`)
// ---------------------------------------------------------------------------

/** 1000 deterministic bytes, so a byte range is checkable. */
export const VIDEO_BYTES = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));

/** Extensions served from the static directory, with the file name each is written as. */
export const STATIC_FILES: Record<string, string | Buffer> = {
  "assets/app-abc123.js": "console.log(1);",
  "styles.css": "body{}",
  "data.json": "{}",
  "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
  "icon.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  "image.avif": Buffer.from([0, 0, 0, 0]),
  "font.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32]),
  "notes.txt": "notes",
  "readme.md": "# readme",
  "feed.xml": "<feed/>",
  "site.webmanifest": "{}",
  "module.wasm": Buffer.from([0, 0x61, 0x73, 0x6d]),
  "video.mp4": VIDEO_BYTES,
  "audio.mp3": Buffer.from([0xff, 0xfb]),
  "doc.pdf": "%PDF-1.4",
  "rows.csv": "a,b",
  // A `public/` file: Vite copies it under its decoded name.
  "legal terms.txt": "legal",
  // A prerendered page: `pracht build` writes it at the encoded route path.
  "posts/caf%C3%A9/index.html": "<!doctype html><p>café</p>",
};

export interface StaticOutput {
  root: string;
  clientDir: string;
  /** A file next to (not inside) the client directory. */
  secretPath: string;
  writePrerenderedISG(path: string, html: string, mtimeMs: number): void;
  cleanup(): void;
}

export function createStaticOutput(
  options: { build?: string; generatedAt?: number } = {},
): StaticOutput {
  const root = mkdtempSync(join(tmpdir(), "pracht-conformance-"));
  const clientDir = join(root, "client");
  mkdirSync(clientDir);
  for (const [name, contents] of Object.entries(STATIC_FILES)) {
    const file = join(clientDir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  const secretPath = join(root, "secret.txt");
  writeFileSync(secretPath, "top-secret");

  const writePrerenderedISG = (path: string, html: string, mtimeMs: number) => {
    const file = join(clientDir, `.${path}`, "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
    const seconds = mtimeMs / 1000;
    utimesSync(file, seconds, seconds);
  };
  const build = options.build ?? "A";
  const generatedAt = options.generatedAt ?? Date.now() - 3_600_000;
  for (const path of Object.values(ISG_PATHS)) {
    writePrerenderedISG(path, `<!doctype html><p>prerendered:${build}</p>`, generatedAt);
  }

  return {
    root,
    clientDir,
    secretPath,
    writePrerenderedISG,
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface Session {
  readonly id: TargetId;
  /** Send one request; `path` carries the query. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Send a request and hang up once `working` resolves (the app has started
   * on it), the way a browser tab that navigates away does.
   */
  disconnect(
    path: string,
    init: { method?: string; body?: string },
    working: Promise<unknown>,
  ): Promise<void>;
  /** Wait for background work (`waitUntil`, ISG regeneration) to finish. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

/** Headers that make an API or capability POST count as same-origin. */
export const SAME_ORIGIN = { "sec-fetch-site": "same-origin" } as const;

async function listen(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; base: string; port: number }> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, port };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function socketDisconnect(
  port: number,
  path: string,
  init: { method?: string; body?: string },
  working: Promise<unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    const client = httpRequest({
      host: "127.0.0.1",
      port,
      method: init.method ?? "GET",
      path,
      headers: {
        accept: "text/html",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...SAME_ORIGIN,
      },
    });
    client.on("error", () => {});
    client.end(init.body);
    void working.then(() => {
      client.destroy();
      resolve();
    });
  });
}

function nodeSession(
  id: TargetId,
  listener: (req: IncomingMessage, res: ServerResponse) => void,
  settle: () => Promise<void> = async () => {},
): Promise<Session> {
  return listen(listener).then(({ server, base, port }) => ({
    id,
    fetch: (path, init) => fetch(`${base}${path}`, init),
    disconnect: (path, init, working) => socketDisconnect(port, path, init, working),
    settle,
    close: () => closeServer(server),
  }));
}

function webSession(
  id: TargetId,
  handle: (request: Request, waitUntil: (promise: Promise<unknown>) => void) => Promise<Response>,
): Session {
  const pending: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => void pending.push(promise);
  const send = (path: string, init?: RequestInit) =>
    handle(new Request(`http://localhost${path}`, init), waitUntil);
  return {
    id,
    fetch: send,
    async disconnect(path, init, working) {
      const controller = new AbortController();
      void working.then(() => controller.abort(new DOMException("client gone", "AbortError")));
      await send(path, {
        method: init.method ?? "GET",
        body: init.body,
        headers: {
          accept: "text/html",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...SAME_ORIGIN,
        },
        signal: controller.signal,
      }).then(
        (response) => response.body?.cancel(),
        () => {},
      );
    },
    async settle() {
      while (pending.length > 0) await Promise.allSettled(pending.splice(0));
    },
    close: async () => {},
  };
}

export async function startNode(fixture: Fixture, output: StaticOutput): Promise<Session> {
  const handler = createNodeRequestHandler({
    app: fixture.app,
    registry: fixture.registry,
    apiRoutes: fixture.apiRoutes,
    staticDir: output.clientDir,
    isgManifest: fixture.isgManifest,
    // What a generated server entry hands the handler: one id per build.
    buildId: fixture.build,
    canonicalOrigin: "http://localhost",
    maxBodySize: MAX_BODY_SIZE,
  });
  return nodeSession(
    "node",
    (req, res) => void handler(req, res),
    async () => {
      await handler.drain(5_000);
    },
  );
}

// -- Cloudflare: Cache API and the ASSETS binding ---------------------------

export interface MockCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
  readonly keys: string[];
}

/**
 * `caches.default`: entries a `put()` asks not to be stored (`no-store`,
 * `private`, `Set-Cookie`) are dropped, as on Cloudflare.
 */
export function createMockCache(): MockCache {
  const store = new Map<string, Response>();
  return {
    async match(key) {
      return store.get(key.url)?.clone();
    },
    async put(key, response) {
      const cacheControl = response.headers.get("cache-control") ?? "";
      if (/\b(no-store|private)\b/i.test(cacheControl) || response.headers.has("set-cookie")) {
        return;
      }
      store.set(key.url, response);
    },
    get keys() {
      return [...store.keys()];
    },
  };
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mp4": "video/mp4",
};

/**
 * The Workers static assets binding: exact files, then `<path>/index.html`,
 * single byte ranges, 404 otherwise. Only the parts of the platform the
 * adapter's wrapper can disturb are modelled.
 */
function createMockAssets(clientDir: string): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request) {
      const { readFile, stat } = await import("node:fs/promises");
      const { extname } = await import("node:path");
      const pathname = new URL(request.url).pathname;
      for (const candidate of [pathname, `${pathname.replace(/\/$/, "")}/index.html`]) {
        const file = join(clientDir, `.${candidate}`);
        if (!file.startsWith(clientDir)) break;
        const info = await stat(file).catch(() => null);
        if (!info?.isFile()) continue;
        const bytes = await readFile(file);
        const headers = new Headers({
          "content-type": ASSET_CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
          "accept-ranges": "bytes",
          "last-modified": info.mtime.toUTCString(),
        });
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(Number(range[2]), bytes.byteLength - 1);
          headers.set("content-range", `bytes ${start}-${end}/${bytes.byteLength}`);
          return new Response(bytes.subarray(start, end + 1), { status: 206, headers });
        }
        return new Response(request.method === "HEAD" ? null : bytes, { headers });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

export async function startCloudflare(
  fixture: Fixture,
  output: StaticOutput,
  cache: MockCache = createMockCache(),
): Promise<Session & { cache: MockCache }> {
  const previous = (globalThis as { caches?: unknown }).caches;
  (globalThis as { caches?: unknown }).caches = { default: cache };
  const handler = createCloudflareFetchHandler({
    app: fixture.app,
    registry: fixture.registry,
    apiRoutes: fixture.apiRoutes,
    isgManifest: fixture.isgManifest,
    buildId: fixture.build,
  });
  const env = {
    ASSETS: createMockAssets(output.clientDir),
    PRACHT_REVALIDATE_TOKEN: REVALIDATE_TOKEN,
  };
  const session = webSession("cloudflare", (request, waitUntil) =>
    handler(request, env, { waitUntil }),
  );
  return {
    ...session,
    cache,
    close: async () => {
      (globalThis as { caches?: unknown }).caches = previous;
    },
  };
}

export async function startNetlify(
  fixture: Fixture,
  output: StaticOutput,
  purged: string[][] = [],
): Promise<Session> {
  const handler = createNetlifyHandler({
    app: fixture.app,
    registry: fixture.registry,
    apiRoutes: fixture.apiRoutes,
    staticDir: output.clientDir,
    isgManifest: fixture.isgManifest,
    purgeCache: async (options) => void purged.push(options?.tags ?? []),
  });
  return webSession("netlify", (request, waitUntil) => handler(request, { waitUntil }));
}

function createVercelHandler(fixture: Fixture) {
  return createVercelEdgeHandler({
    app: fixture.app,
    registry: fixture.registry,
    apiRoutes: fixture.apiRoutes,
  });
}

export async function startVercelEdge(fixture: Fixture): Promise<Session> {
  const handler = createVercelHandler(fixture);
  return webSession("vercel-edge", (request, waitUntil) => handler(request, { waitUntil }));
}

/**
 * The Node function Vercel runs for an ISG route. Whatever it writes is what
 * Vercel's prerender cache stores and replays, so each call returns that.
 */
export async function startVercelNode(fixture: Fixture): Promise<Session> {
  const listener = createVercelNodeListener(
    createVercelHandler(fixture) as (
      request: Request,
      context: VercelExecutionContext,
    ) => Promise<Response>,
  );
  const invoke = async (path: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = { host: "localhost", "x-forwarded-proto": "http" };
    new Headers(init?.headers).forEach((value, name) => (headers[name] = value));
    const written = new Headers();
    const chunks: Uint8Array[] = [];
    const res = {
      statusCode: 200,
      statusMessage: "",
      setHeader(name: string, value: string | string[]) {
        written.delete(name);
        for (const item of Array.isArray(value) ? value : [value]) written.append(name, item);
      },
      write(chunk: Uint8Array) {
        chunks.push(chunk);
      },
      end() {},
    };
    await listener({ headers, method: init?.method ?? "GET", url: path }, res);
    const body = Buffer.concat(chunks);
    return new Response(res.statusCode === 204 || res.statusCode === 304 ? null : body, {
      status: res.statusCode,
      headers: written,
    });
  };
  return {
    id: "vercel-node",
    fetch: invoke,
    disconnect: async () => {
      throw new Error("The Vercel ISG function has no client to disconnect.");
    },
    settle: async () => {},
    close: async () => {},
  };
}

export async function startStaticPreview(output: StaticOutput): Promise<Session> {
  const handler = createStaticPreviewHandler({ staticDir: output.clientDir });
  return nodeSession("static-preview", (req, res) => void handler(req, res));
}

export async function startDev(fixture: Fixture): Promise<Session> {
  const serverMod = {
    apiRoutes: fixture.apiRoutes,
    islandsBootstrapRequired: false,
    registry: fixture.registry,
    resolvedApp: resolveApp(fixture.app),
  };
  const silent = () => {};
  const server = {
    config: {
      base: "/",
      logger: { error: silent, info: silent, warn: silent, warnOnce: silent },
      root: tmpdir(),
    },
    environments: {
      ssr: { moduleGraph: { getModuleByUrl: async () => undefined } },
    },
    moduleGraph: { getModuleByUrl: async () => undefined },
    ssrFixStacktrace: silent,
    ssrLoadModule: async (id: string) => {
      if (id === "@pracht/core/server") return frameworkServer;
      if (id === PRACHT_SERVER_MODULE_ID) return serverMod;
      throw new Error(`Unexpected ssrLoadModule id: ${id}`);
    },
    transformIndexHtml: async (_url: string, html: string) => html,
  } as unknown as ViteDevServer;
  const middleware = createDevSSRMiddleware(server, { maxBodySize: MAX_BODY_SIZE });
  return nodeSession("dev", (req, res) => {
    void middleware(req, res, () => {
      res.statusCode = 404;
      res.end("next()");
    });
  });
}

/**
 * A document's headers as a sorted plain record, for comparison across
 * targets. `Vary: Accept-Encoding` belongs to a transfer (Node compresses on
 * the fly), so it is dropped along with `omit`.
 */
export function headerRecord(headers: Headers, omit: ReadonlySet<string>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (omit.has(name)) continue;
    if (name === "vary") {
      const varied = value
        .split(",")
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token && token !== "accept-encoding")
        .sort();
      if (varied.length > 0) record[name] = varied.join(", ");
      continue;
    }
    record[name] = value;
  }
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
