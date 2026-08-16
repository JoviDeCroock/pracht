import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  createStaticPreviewHandler,
  createStaticServerEntryModule,
  staticAdapter,
} from "../src/index.ts";

describe("staticAdapter", () => {
  it("identifies itself as the static target", () => {
    const adapter = staticAdapter();
    expect(adapter.id).toBe("static");
    expect(adapter.staticTarget).toBe(true);
    expect(adapter.edge).toBeUndefined();
    expect(adapter.ownsDevServer).toBeUndefined();
  });

  it("generates an entry exposing the static-export build hooks", () => {
    const source = staticAdapter({
      fallback: "200.html",
      fallbackHead: { meta: [{ content: "shared", name: "description" }], title: "Fallback" },
    }).createServerEntryModule();
    expect(source).toContain(
      'export const staticExportConfig = { fallback: "200.html", fallbackHead: {"meta":[{"content":"shared","name":"description"}],"title":"Fallback"} };',
    );
    expect(source).toContain("const staticNotFoundApp = { ...resolvedApp, routes: [] };");
    expect(source).toContain("export async function renderStaticNotFoundHtml()");
    expect(source).toContain("app: staticNotFoundApp");
    expect(source).toContain("if (!resolvedApp.notFound) return null;");
    expect(source).toContain("Static export failed to render the notFound page");
    expect(source).toContain("export function renderStaticFallbackHtml(notFoundState)");
    expect(source).toContain("head: staticExportConfig.fallbackHead ?? undefined,");
    expect(source).toContain("notFoundData: notFoundState?.data,");
    expect(source).toContain("notFoundError: notFoundState?.error ?? null,");
    expect(source).toContain("createStaticPreviewHandler");
  });

  it("defaults to no fallback document", () => {
    expect(createStaticServerEntryModule()).toContain(
      "export const staticExportConfig = { fallback: null, fallbackHead: null };",
    );
  });

  it("rejects fallback metadata without a fallback document", () => {
    expect(() => staticAdapter({ fallbackHead: { title: "Unused" } })).toThrow(
      /requires a fallback file/,
    );
  });

  it("rejects fallback names that are not plain html files", () => {
    expect(() => staticAdapter({ fallback: "../200.html" })).toThrow(/plain HTML file name/);
    expect(() => staticAdapter({ fallback: "200.js" })).toThrow(/plain HTML file name/);
    expect(() => staticAdapter({ fallback: "a/b.html" })).toThrow(/plain HTML file name/);
  });

  it("rejects reserved fallback names", () => {
    expect(() => staticAdapter({ fallback: "index.html" })).toThrow(/reserved/);
    expect(() => staticAdapter({ fallback: "Index.html" })).toThrow(/reserved/);
    expect(() => staticAdapter({ fallback: "404.html" })).toThrow(/reserved/);
    expect(() => staticAdapter({ fallback: "404.HTML" })).toThrow(/reserved/);
  });

  it("rejects fallback names that are not portable", () => {
    for (const fallback of ["CON.html", "aux.html", "com9.html", "LPT1.html"]) {
      expect(() => staticAdapter({ fallback })).toThrow(/not a portable file name/);
    }
    expect(() => staticAdapter({ fallback: `${"a".repeat(251)}.html` })).toThrow(
      /not a portable file name/,
    );
  });
});

describe("createStaticPreviewHandler", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function startPreview(options?: { fallback?: string | null }): Promise<{
    origin: string;
    staticDir: string;
  }> {
    const staticDir = mkdtempSync(join(tmpdir(), "pracht-static-preview-"));
    cleanups.push(() => rmSync(staticDir, { force: true, recursive: true }));

    writeFileSync(resolve(staticDir, "index.html"), "<h1>home</h1>", "utf-8");
    mkdirSync(resolve(staticDir, "about"), { recursive: true });
    writeFileSync(resolve(staticDir, "about/index.html"), "<h1>about</h1>", "utf-8");
    mkdirSync(resolve(staticDir, "assets"), { recursive: true });
    writeFileSync(resolve(staticDir, "assets/app-abc.js"), "console.log(1)", "utf-8");
    mkdirSync(resolve(staticDir, "_pracht/state/s-00610062006f00750074"), { recursive: true });
    writeFileSync(
      resolve(staticDir, "_pracht/state/s-00610062006f00750074/_state.json"),
      '{"data":{"ok":true}}',
      "utf-8",
    );
    writeFileSync(resolve(staticDir, "404.html"), "<h1>not found page</h1>", "utf-8");
    if (options?.fallback) {
      writeFileSync(resolve(staticDir, options.fallback), "<h1>spa fallback</h1>", "utf-8");
    }

    const handler = createStaticPreviewHandler({ staticDir, fallback: options?.fallback ?? null });
    const server: Server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    cleanups.push(() => server.close());
    const { port } = server.address() as AddressInfo;
    return { origin: `http://127.0.0.1:${port}`, staticDir };
  }

  it("serves files, clean URLs, and state JSON with proper headers", async () => {
    const { origin } = await startPreview();

    const home = await fetch(`${origin}/`);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("home");

    const about = await fetch(`${origin}/about`);
    expect(about.status).toBe(200);
    expect(about.headers.get("content-type")).toContain("text/html");
    expect(await about.text()).toContain("about");

    const state = await fetch(`${origin}/_pracht/state/s-00610062006f00750074/_state.json`);
    expect(state.status).toBe(200);
    expect(state.headers.get("content-type")).toBe("application/json");
    await expect(state.json()).resolves.toEqual({ data: { ok: true } });

    const asset = await fetch(`${origin}/assets/app-abc.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("answers misses with 404.html and status 404", async () => {
    const { origin } = await startPreview();
    const miss = await fetch(`${origin}/nope`);
    expect(miss.status).toBe(404);
    expect(await miss.text()).toContain("not found page");
  });

  it("does not use a clean-URL /404.html route as the error document", async () => {
    const { origin, staticDir } = await startPreview();
    rmSync(resolve(staticDir, "404.html"));
    mkdirSync(resolve(staticDir, "404.html"), { recursive: true });
    writeFileSync(resolve(staticDir, "404.html/index.html"), "<h1>ordinary route</h1>", "utf-8");

    const miss = await fetch(`${origin}/nope`);
    expect(miss.status).toBe(404);
    expect(await miss.text()).toBe("Not found");
  });

  it("serves the configured SPA fallback with status 200 for misses", async () => {
    const { origin } = await startPreview({ fallback: "200.html" });
    const miss = await fetch(`${origin}/items/42`);
    expect(miss.status).toBe(200);
    expect(await miss.text()).toContain("spa fallback");
  });

  it("refuses path traversal outside the static dir", async () => {
    const { origin } = await startPreview();
    const attempt = await fetch(`${origin}/%2e%2e/%2e%2e/etc/passwd`);
    // Falls through to the 404 document rather than serving anything outside.
    expect(attempt.status).toBe(404);
    expect(await attempt.text()).toContain("not found page");
  });

  it("supports HEAD and rejects other methods", async () => {
    const { origin } = await startPreview();
    const head = await fetch(`${origin}/about`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const post = await fetch(`${origin}/about`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});
