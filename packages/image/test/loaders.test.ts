import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cloudflareLoader,
  createDefaultLoader,
  defaultLoader,
  passthroughLoader,
  vercelLoader,
} from "../src/index.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("defaultLoader", () => {
  it("targets the pracht image API route with encoded url, width, and quality", () => {
    expect(defaultLoader({ src: "/hero image.jpg", width: 640, quality: 60 })).toBe(
      "/api/_pracht/image?url=%2Fhero%20image.jpg&w=640&q=60",
    );
  });

  it("falls back to quality 75", () => {
    expect(defaultLoader({ src: "/hero.jpg", width: 828 })).toBe(
      "/api/_pracht/image?url=%2Fhero.jpg&w=828&q=75",
    );
  });
});

describe("createDefaultLoader", () => {
  it("supports a custom endpoint path", () => {
    const loader = createDefaultLoader("/api/images");
    expect(loader({ src: "/a.png", width: 128, quality: 90 })).toBe(
      "/api/images?url=%2Fa.png&w=128&q=90",
    );
  });

  it("targets app endpoints under the Vite deploy base", async () => {
    vi.resetModules();
    vi.stubEnv("BASE_URL", "/app/");
    const { createDefaultLoader: createUnderBase, defaultLoader: defaultUnderBase } =
      await import("../src/index.ts");

    expect(defaultUnderBase({ src: "/hero.jpg", width: 640 })).toBe(
      "/app/api/_pracht/image?url=%2Fhero.jpg&w=640&q=75",
    );
    expect(createUnderBase("/api/images")({ src: "/a.png", width: 128 })).toBe(
      "/app/api/images?url=%2Fa.png&w=128&q=75",
    );
    expect(createUnderBase("https://images.example/resize")({ src: "/a.png", width: 128 })).toBe(
      "https://images.example/resize?url=%2Fa.png&w=128&q=75",
    );
  });
});

describe("cloudflareLoader", () => {
  it("builds a Cloudflare Image Resizing URL and strips the leading slash", () => {
    expect(cloudflareLoader({ src: "/hero.jpg", width: 1080, quality: 80 })).toBe(
      "/cdn-cgi/image/width=1080,quality=80,format=auto/hero.jpg",
    );
  });

  it("keeps absolute source URLs intact", () => {
    expect(cloudflareLoader({ src: "https://cdn.example.com/hero.jpg", width: 640 })).toBe(
      "/cdn-cgi/image/width=640,quality=75,format=auto/https://cdn.example.com/hero.jpg",
    );
  });
});

describe("vercelLoader", () => {
  it("builds a Vercel image optimization URL", () => {
    expect(vercelLoader({ src: "/hero.jpg", width: 1200, quality: 75 })).toBe(
      "/_vercel/image?url=%2Fhero.jpg&w=1200&q=75",
    );
  });
});

describe("passthroughLoader", () => {
  it("returns the source untouched", () => {
    expect(passthroughLoader({ src: "/hero.jpg", width: 3840, quality: 10 })).toBe("/hero.jpg");
  });
});
