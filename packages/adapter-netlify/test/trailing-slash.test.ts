import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createHandler(policy: "ignore" | "never" | "always") {
  vi.resetModules();
  vi.stubGlobal("__PRACHT_TRAILING_SLASH__", policy);
  const [core, adapter] = await Promise.all([import("@pracht/core"), import("../src/index.ts")]);
  const staticDir = await mkdtemp(join(tmpdir(), "pracht-netlify-slash-"));
  tempDirs.push(staticDir);
  await mkdir(join(staticDir, "guide"), { recursive: true });
  await writeFile(join(staticDir, "guide/index.html"), "<main>guide</main>", "utf-8");
  const renderedUrls: string[] = [];
  const revalidate = core.timeRevalidate(60);
  const handler = adapter.createNetlifyHandler({
    app: core.defineApp({
      routes: [
        core.route("/guide", "./routes/page.tsx", { render: "ssg" }),
        core.route("/pricing", "./routes/page.tsx", { render: "isg", revalidate }),
      ],
    }),
    isgManifest: { "/pricing": { revalidate } },
    registry: {
      routeModules: {
        "./routes/page.tsx": async () => ({
          default: () => h("main", null, "page"),
          loader: ({ request }: { request: Request }) => {
            renderedUrls.push(request.url);
            return null;
          },
        }),
      },
    },
    staticDir,
  });
  return {
    get: (path: string) => handler(new Request(`https://example.com${path}`), {}),
    renderedUrls,
  };
}

describe('Netlify adapter under trailingSlash: "always"', () => {
  it("redirects prerendered and ISG pages to the slash form and renders that one", async () => {
    const { get, renderedUrls } = await createHandler("always");
    const guide = await get("/guide?x=1");
    expect(guide.status).toBe(308);
    expect(guide.headers.get("location")).toBe("/guide/?x=1");
    expect((await get("/guide/")).status).toBe(200);

    const pricing = await get("/pricing?x=1");
    expect(pricing.status).toBe(308);
    expect(pricing.headers.get("location")).toBe("/pricing/?x=1");
    expect(renderedUrls).toHaveLength(0);

    const canonical = await get("/pricing/");
    expect(canonical.status).toBe(200);
    expect(renderedUrls).toEqual(["https://example.com/pricing/"]);
  });
});

describe('Netlify adapter under trailingSlash: "never"', () => {
  it("redirects the slash form of prerendered pages", async () => {
    const { get } = await createHandler("never");
    const guide = await get("/guide/");
    expect(guide.status).toBe(308);
    expect(guide.headers.get("location")).toBe("/guide");
    expect((await get("/guide")).status).toBe(200);
  });
});

describe("Netlify adapter by default", () => {
  it("serves both spellings of a prerendered page", async () => {
    const { get } = await createHandler("ignore");
    expect((await get("/guide")).status).toBe(200);
    expect((await get("/guide/")).status).toBe(200);
  });
});
