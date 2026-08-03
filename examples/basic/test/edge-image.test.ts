import { describe, expect, it } from "vitest";
import { GET, HEAD } from "../src/api-edge/_pracht/image.ts";

function call(handler: typeof GET, url: string) {
  return handler({ request: new Request(url) } as Parameters<typeof GET>[0]);
}

describe("edge image fallback", () => {
  it.each([GET, HEAD])("redirects same-origin paths", (handler) => {
    const response = call(
      handler,
      "https://example.test/api/_pracht/image?url=%2Fgallery%2Fsample.svg",
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.test/gallery/sample.svg");
  });

  it.each([
    "https://images.example/asset.png",
    "//images.example/asset.png",
    "/\\images.example/asset.png",
  ])("rejects unsafe source %s", (source) => {
    const response = call(
      GET,
      `https://example.test/api/_pracht/image?url=${encodeURIComponent(source)}`,
    );

    expect(response.status).toBe(400);
  });
});
