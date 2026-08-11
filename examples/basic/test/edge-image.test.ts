import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type ImageHandler = (typeof import("../src/api/_pracht/image.ts"))["GET"];

let GET: ImageHandler;
let HEAD: ImageHandler;

beforeAll(async () => {
  // Vite replaces this identifier per deployment target. Supply the edge
  // value before importing the canonical route so this unit test exercises
  // the same branch as Cloudflare and Vercel builds.
  vi.stubGlobal("__PRACHT_IMAGE_BACKEND__", "passthrough");
  ({ GET, HEAD } = await import("../src/api/_pracht/image.ts"));
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function call(handler: ImageHandler, url: string) {
  return handler({ request: new Request(url) } as Parameters<typeof GET>[0]);
}

describe("edge image fallback", () => {
  it.each(["GET", "HEAD"] as const)("redirects same-origin paths for %s", async (method) => {
    const response = await call(
      method === "GET" ? GET : HEAD,
      "https://example.test/api/_pracht/image?url=%2Fgallery%2Fsample.svg",
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.test/gallery/sample.svg");
  });

  it.each([
    "https://images.example/asset.png",
    "//images.example/asset.png",
    "/\\images.example/asset.png",
    "/\t/images.example/asset.png",
    "/\r/images.example/asset.png",
    "/\n/images.example/asset.png",
  ])("rejects unsafe source %s", async (source) => {
    const response = await call(
      GET,
      `https://example.test/api/_pracht/image?url=${encodeURIComponent(source)}`,
    );

    expect(response.status).toBe(400);
  });
});
