import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { createImageHandler, type CreateImageHandlerOptions } from "../src/node.ts";

let sourcePng: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  sourcePng = new Uint8Array(
    await sharp({
      create: {
        width: 1200,
        height: 800,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .png()
      .toBuffer(),
  );
});

function pngFetcher(): CreateImageHandlerOptions["fetchImage"] {
  return async () => new Response(sourcePng, { headers: { "content-type": "image/png" } });
}

function imageRequest(query: string, accept = "image/webp,image/png,*/*"): { request: Request } {
  return {
    request: new Request(`http://localhost:3000/api/_pracht/image?${query}`, {
      headers: { accept },
    }),
  };
}

describe("createImageHandler validation", () => {
  const handler = createImageHandler({ fetchImage: pngFetcher() });

  it("rejects requests without a url parameter", async () => {
    const response = await handler(imageRequest("w=640"));
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('"url"');
  });

  it("rejects protocol-relative urls", async () => {
    const response = await handler(imageRequest("url=%2F%2Fevil.com%2Fa.png&w=640"));
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Protocol-relative");
  });

  it("rejects non-relative, non-http urls", async () => {
    const response = await handler(imageRequest("url=file%3A%2F%2F%2Fetc%2Fpasswd&w=640"));
    expect(response.status).toBe(400);
  });

  it("rejects remote urls when no remotePatterns are configured", async () => {
    const response = await handler(imageRequest("url=https%3A%2F%2Fexample.com%2Fa.png&w=640"));
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("remotePatterns");
  });

  it("rejects missing or non-integer widths", async () => {
    expect((await handler(imageRequest("url=%2Fa.png"))).status).toBe(400);
    expect((await handler(imageRequest("url=%2Fa.png&w=abc"))).status).toBe(400);
    expect((await handler(imageRequest("url=%2Fa.png&w=-2"))).status).toBe(400);
  });

  it("rejects widths outside the allowlist to protect the cache", async () => {
    const response = await handler(imageRequest("url=%2Fa.png&w=333"));
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("not allowed");
  });

  it("caps the maximum width", async () => {
    const capped = createImageHandler({
      fetchImage: pngFetcher(),
      allowedWidths: [],
      maxWidth: 1024,
    });
    const response = await capped(imageRequest("url=%2Fa.png&w=2048"));
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("1024");
  });

  it("rejects out-of-range quality values", async () => {
    expect((await handler(imageRequest("url=%2Fa.png&w=640&q=0"))).status).toBe(400);
    expect((await handler(imageRequest("url=%2Fa.png&w=640&q=101"))).status).toBe(400);
  });

  it("only answers GET/HEAD", async () => {
    const response = await handler({
      request: new Request("http://localhost:3000/api/_pracht/image?url=%2Fa.png&w=640", {
        method: "POST",
      }),
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("createImageHandler remote allowlist", () => {
  it("allows remote sources matching a remotePattern, including wildcards", async () => {
    const handler = createImageHandler({
      fetchImage: pngFetcher(),
      remotePatterns: [{ protocol: "https", hostname: "*.example.com", pathname: "/images" }],
    });

    const allowed = await handler(
      imageRequest("url=https%3A%2F%2Fcdn.example.com%2Fimages%2Fa.png&w=640"),
    );
    expect(allowed.status).toBe(200);

    const wrongPath = await handler(
      imageRequest("url=https%3A%2F%2Fcdn.example.com%2Fother%2Fa.png&w=640"),
    );
    expect(wrongPath.status).toBe(403);

    const wrongHost = await handler(
      imageRequest("url=https%3A%2F%2Fexample.org%2Fimages%2Fa.png&w=640"),
    );
    expect(wrongHost.status).toBe(403);

    const wrongProtocol = await handler(
      imageRequest("url=http%3A%2F%2Fcdn.example.com%2Fimages%2Fa.png&w=640"),
    );
    expect(wrongProtocol.status).toBe(403);
  });

  it("rejects fetches that redirect outside the allowlist", async () => {
    const redirected = new Response(sourcePng, { headers: { "content-type": "image/png" } });
    Object.defineProperty(redirected, "url", { value: "https://evil.com/a.png" });
    const handler = createImageHandler({ fetchImage: async () => redirected });

    const response = await handler(imageRequest("url=%2Fa.png&w=640"));
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("redirected");
  });
});

describe("createImageHandler optimization", () => {
  it("resizes and re-encodes to webp when the client accepts it", async () => {
    const handler = createImageHandler({ fetchImage: pngFetcher() });
    const response = await handler(imageRequest("url=%2Fhero.png&w=640&q=75"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const body = new Uint8Array(await response.arrayBuffer());
    const metadata = await sharp(body).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(640);
  });

  it("never enlarges beyond the source width", async () => {
    const handler = createImageHandler({ fetchImage: pngFetcher() });
    const response = await handler(imageRequest("url=%2Fhero.png&w=1920"));

    const metadata = await sharp(new Uint8Array(await response.arrayBuffer())).metadata();
    expect(metadata.width).toBe(1200);
  });

  it("keeps png output when the client does not accept modern formats", async () => {
    const handler = createImageHandler({ fetchImage: pngFetcher() });
    const response = await handler(imageRequest("url=%2Fhero.png&w=640", "image/png"));

    expect(response.headers.get("content-type")).toBe("image/png");
    const metadata = await sharp(new Uint8Array(await response.arrayBuffer())).metadata();
    expect(metadata.format).toBe("png");
  });

  it("serves avif when opted in and accepted", async () => {
    const handler = createImageHandler({
      fetchImage: pngFetcher(),
      formats: ["image/avif", "image/webp"],
    });
    const response = await handler(
      imageRequest("url=%2Fhero.png&w=64", "image/avif,image/webp,*/*"),
    );

    expect(response.headers.get("content-type")).toBe("image/avif");
  });

  it("passes svg through untouched with a download disposition", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    const handler = createImageHandler({
      fetchImage: async () => new Response(svg, { headers: { "content-type": "image/svg+xml" } }),
    });
    const response = await handler(imageRequest("url=%2Flogo.svg&w=640"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    await expect(response.text()).resolves.toBe(svg);
  });

  it("propagates upstream failures as 502", async () => {
    const handler = createImageHandler({
      fetchImage: async () => new Response("nope", { status: 404 }),
    });
    const response = await handler(imageRequest("url=%2Fmissing.png&w=640"));
    expect(response.status).toBe(502);
  });

  it("rejects non-image sources", async () => {
    const handler = createImageHandler({
      fetchImage: async () =>
        new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    });
    const response = await handler(imageRequest("url=%2Fpage&w=640"));
    expect(response.status).toBe(415);
  });

  it("rejects oversized sources", async () => {
    const handler = createImageHandler({ fetchImage: pngFetcher(), maxSourceBytes: 10 });
    const response = await handler(imageRequest("url=%2Fhero.png&w=640"));
    expect(response.status).toBe(413);
  });

  it("stops reading the source body after the size cap is exceeded", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        canceled = true;
      },
    });
    const handler = createImageHandler({
      fetchImage: async () => new Response(body, { headers: { "content-type": "image/png" } }),
      maxSourceBytes: 10,
    });

    const response = await handler(imageRequest("url=%2Fhero.png&w=640"));

    expect(response.status).toBe(413);
    expect(canceled).toBe(true);
  });

  it("explains how to install sharp when it is missing", async () => {
    const handler = createImageHandler({
      fetchImage: pngFetcher(),
      loadSharp: () => Promise.reject(new Error("Cannot find module 'sharp'")),
    });
    const response = await handler(imageRequest("url=%2Fhero.png&w=640"));

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("sharp");
    expect(body).toContain("pnpm add sharp");
  });
});
