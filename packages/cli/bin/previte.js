#!/usr/bin/env node

import { createServer as createHttpServer } from "node:http";
import { resolve, join, dirname, extname } from "node:path";
import {
  existsSync,
  statSync,
  mkdirSync,
  writeFileSync,
  createReadStream,
  readFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import { createServer, build as viteBuild } from "vite";

const DEFAULT_SECURITY_HEADERS = {
  "permissions-policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
};

const VERSION = "0.0.0";
const command = process.argv[2];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log(VERSION);
  process.exit(0);
}

const handlers = { dev, build, preview };

if (!(command in handlers)) {
  console.error(`Unknown previte command: ${command}`);
  printHelp();
  process.exit(1);
}

handlers[command]().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function dev() {
  const port = parseInt(process.env.PORT || process.argv[3] || "3000", 10);

  const server = await createServer({
    root: process.cwd(),
    server: { port },
  });

  await server.listen();
  server.printUrls();
}

async function build() {
  // 1. Client build
  console.log("\n  Building client...\n");
  await viteBuild({
    root: process.cwd(),
    build: {
      outDir: "dist/client",
      manifest: true,
      rollupOptions: {
        input: "virtual:previte/client",
      },
    },
  });

  // 2. SSR build
  console.log("\n  Building server...\n");
  await viteBuild({
    root: process.cwd(),
    build: {
      ssr: "virtual:previte/server",
      outDir: "dist/server",
    },
  });

  // 3. SSG prerendering
  const root = process.cwd();
  const serverEntry = resolve(root, "dist/server/server.js");
  const clientDir = resolve(root, "dist/client");

  if (existsSync(serverEntry)) {
    const serverMod = await import(serverEntry);
    const { prerenderApp } = await import("previte");

    // Read the Vite manifest for asset URLs
    const manifestPath = resolve(clientDir, ".vite/manifest.json");
    const viteManifest = existsSync(manifestPath)
      ? JSON.parse(readFileSync(manifestPath, "utf-8"))
      : {};

    const clientEntry = viteManifest["virtual:previte/client"];
    const clientEntryUrl = clientEntry ? `/${clientEntry.file}` : undefined;

    // Build per-source-file CSS manifest by walking static imports transitively.
    // This ensures each page gets only the CSS it actually needs.
    function collectTransitiveCss(key) {
      const css = new Set();
      const visited = new Set();
      function collect(k) {
        if (visited.has(k)) return;
        visited.add(k);
        const entry = viteManifest[k];
        if (!entry) return;
        for (const c of entry.css ?? []) css.add(c);
        for (const imp of entry.imports ?? []) collect(imp);
      }
      collect(key);
      return [...css];
    }

    const cssManifest = {};
    for (const [key, entry] of Object.entries(viteManifest)) {
      if (!entry.src) continue;
      const css = collectTransitiveCss(key);
      if (css.length > 0) {
        cssManifest[key] = css.map((f) => `/${f}`);
      }
    }

    const { pages, isgManifest } = await prerenderApp({
      app: serverMod.resolvedApp,
      registry: serverMod.registry,
      clientEntryUrl,
      cssManifest,
      withISGManifest: true,
    });

    if (pages.length > 0) {
      console.log(`\n  Prerendering ${pages.length} SSG/ISG route(s)...\n`);
      for (const page of pages) {
        const filePath =
          page.path === "/"
            ? join(clientDir, "index.html")
            : join(clientDir, page.path, "index.html");

        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, page.html, "utf-8");
        console.log(`    ${page.path} → ${filePath.replace(root + "/", "")}`);
      }
    }

    // Write ISG manifest for the preview/production server
    if (Object.keys(isgManifest).length > 0) {
      const isgManifestPath = resolve(root, "dist/server/isg-manifest.json");
      writeFileSync(isgManifestPath, JSON.stringify(isgManifest, null, 2), "utf-8");
      console.log(
        `\n  ISG manifest → dist/server/isg-manifest.json (${Object.keys(isgManifest).length} route(s))\n`,
      );
    }

    if (serverMod.buildTarget === "cloudflare") {
      console.log(`\n  Cloudflare worker → dist/server/server.js\n`);
      console.log(`  Deploy with: wrangler deploy\n`);
    }

    if (serverMod.buildTarget === "vercel") {
      const outputPath = writeVercelBuildOutput({
        functionName: serverMod.vercelFunctionName,
        regions: serverMod.vercelRegions,
        root,
        staticRoutes: pages.map((page) => page.path).filter((path) => !(path in isgManifest)),
        isgRoutes: Object.keys(isgManifest),
      });

      console.log(`\n  Vercel build output → ${outputPath}\n`);
    }
  }

  console.log("\n  Build complete.\n");
}

async function preview() {
  const root = process.cwd();
  const clientDir = resolve(root, "dist/client");
  const serverEntry = resolve(root, "dist/server/server.js");

  if (!existsSync(serverEntry)) {
    console.error("Server build not found at dist/server/. Run `previte build` first.");
    process.exit(1);
  }

  const serverMod = await import(serverEntry);
  const { handlePreviteRequest } = await import("previte");

  // Load ISG manifest if it exists
  const isgManifestPath = resolve(root, "dist/server/isg-manifest.json");
  const isgManifest = existsSync(isgManifestPath)
    ? JSON.parse(readFileSync(isgManifestPath, "utf-8"))
    : {};

  // Read the Vite manifest for asset URLs
  const manifestPath = resolve(clientDir, ".vite/manifest.json");
  const viteManifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf-8"))
    : {};

  // Find the client entry asset from the manifest
  const clientEntry = viteManifest["virtual:previte/client"];
  const clientEntryUrl = clientEntry ? `/${clientEntry.file}` : undefined;
  const cssUrls = (clientEntry?.css ?? []).map((f) => `/${f}`);

  const MIME_TYPES = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };

  const port = parseInt(process.argv[3] || "3000", 10);

  const server = createHttpServer(async (req, res) => {
    const url = req.url ?? "/";

    const parsedUrl = new URL(url, "http://localhost");

    // ISG stale-while-revalidate check
    if (req.method === "GET" && parsedUrl.pathname in isgManifest) {
      const entry = isgManifest[parsedUrl.pathname];
      const htmlPath =
        parsedUrl.pathname === "/"
          ? join(clientDir, "index.html")
          : join(clientDir, parsedUrl.pathname, "index.html");

      if (existsSync(htmlPath) && statSync(htmlPath).isFile()) {
        const stat = statSync(htmlPath);
        const ageMs = Date.now() - stat.mtimeMs;
        const isStale = entry.revalidate.kind === "time" && ageMs > entry.revalidate.seconds * 1000;

        setDefaultSecurityHeaders(res, {
          "content-type": "text/html; charset=utf-8",
          "x-previte-isg": isStale ? "stale" : "fresh",
        });
        createReadStream(htmlPath).pipe(res);

        if (isStale) {
          // Background regeneration
          const regenRequest = new Request(new URL(parsedUrl.pathname, "http://localhost"), {
            method: "GET",
          });
          handlePreviteRequest({
            app: serverMod.resolvedApp,
            registry: serverMod.registry,
            request: regenRequest,
            clientEntryUrl,
            cssUrls,
          })
            .then(async (response) => {
              if (response.status === 200) {
                const { mkdirSync, writeFileSync } = await import("node:fs");
                mkdirSync(dirname(htmlPath), { recursive: true });
                writeFileSync(htmlPath, await response.text(), "utf-8");
              }
            })
            .catch((err) => {
              console.error(`ISG regeneration failed for ${parsedUrl.pathname}:`, err);
            });
        }
        return;
      }
    }

    // Try static file first
    const filePath = resolve(clientDir, "." + url);
    if (!filePath.startsWith(clientDir + "/") && filePath !== clientDir) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath);
      const headers = {
        "content-type": MIME_TYPES[ext] || "application/octet-stream",
      };
      if (ext === ".html") {
        setDefaultSecurityHeaders(res, headers);
      } else {
        for (const [key, value] of Object.entries(headers)) {
          res.setHeader(key, value);
        }
      }
      createReadStream(filePath).pipe(res);
      return;
    }

    // SSR fallback
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }

      const protocol = req.headers["x-forwarded-proto"] || "http";
      const host = req.headers.host || "localhost";
      const webRequest = new Request(new URL(url, `${protocol}://${host}`), {
        method: req.method,
        headers,
      });

      const response = await handlePreviteRequest({
        app: serverMod.resolvedApp,
        registry: serverMod.registry,
        request: webRequest,
        clientEntryUrl,
        cssUrls,
        apiRoutes: serverMod.apiRoutes,
      });

      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      if (!response.body) {
        res.end();
        return;
      }

      const body = Buffer.from(await response.arrayBuffer());
      res.end(body);
    } catch (err) {
      console.error("SSR error:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  server.listen(port, () => {
    console.log(`\n  previte preview server running at http://localhost:${port}\n`);
  });
}

function printHelp() {
  console.log(`previte ${VERSION}

Usage:
  previte dev       Start development server with HMR
  previte build     Production build (client + server)
  previte preview   Preview the production build
`);
}

function setDefaultSecurityHeaders(res, headers = {}) {
  for (const [key, value] of Object.entries({
    ...DEFAULT_SECURITY_HEADERS,
    ...headers,
  })) {
    res.setHeader(key, value);
  }
}

function writeVercelBuildOutput({ functionName, regions, root, staticRoutes, isgRoutes }) {
  const outputDir = join(root, ".vercel/output");
  const staticDir = join(outputDir, "static");
  const functionDir = join(outputDir, "functions", `${functionName || "render"}.func`);

  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(join(root, "dist/client"), staticDir, { recursive: true });
  cpSync(join(root, "dist/server"), functionDir, { recursive: true });

  writeFileSync(
    join(outputDir, "config.json"),
    `${JSON.stringify(createVercelOutputConfig({ functionName, staticRoutes, isgRoutes }), null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(
    join(functionDir, ".vc-config.json"),
    `${JSON.stringify(createVercelFunctionConfig({ regions }), null, 2)}\n`,
    "utf-8",
  );

  return ".vercel/output";
}

function createVercelOutputConfig({ functionName, staticRoutes, isgRoutes }) {
  const target = `/${functionName || "render"}`;
  const routes = [];

  for (const route of sortStaticRoutes(staticRoutes)) {
    routes.push({
      src: routeToRouteExpression(route),
      dest: routeToStaticHtmlPath(route),
    });
  }

  for (const route of isgRoutes) {
    routes.push({
      src: routeToRouteExpression(route),
      dest: target,
    });
  }

  routes.push({ handle: "filesystem" });
  routes.push({ src: "/(.*)", dest: target });

  return {
    version: 3,
    routes,
    framework: {
      version: VERSION,
    },
  };
}

function createVercelFunctionConfig({ regions }) {
  const config = {
    runtime: "edge",
    entrypoint: "server.js",
  };

  if (regions) {
    config.regions = regions;
  }

  return config;
}

function sortStaticRoutes(routes) {
  return [...new Set(routes)].sort((left, right) => right.length - left.length);
}

function routeToRouteExpression(route) {
  if (route === "/") {
    return "^/$";
  }

  return `^${escapeRegex(route)}/?$`;
}

function routeToStaticHtmlPath(route) {
  if (route === "/") {
    return "/index.html";
  }

  return `${route}/index.html`;
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}
