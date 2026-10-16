import { beforeEach, describe, expect, it, vi } from "vitest";

const cloudflare = vi.hoisted(() => vi.fn((_options: unknown) => []));

vi.mock("@cloudflare/vite-plugin", () => ({ cloudflare }));

const { cloudflareAdapter } = await import("../src/index.ts");

describe("cloudflareAdapter Vite plugin options", () => {
  beforeEach(() => {
    cloudflare.mockClear();
  });

  it("leaves the Wrangler config lookup to Cloudflare by default", () => {
    cloudflareAdapter().vitePlugins?.();

    expect(cloudflare).toHaveBeenCalledWith(
      expect.objectContaining({ config: { main: "virtual:pracht/server" }, configPath: undefined }),
    );
  });

  it("points the local runtime at a generated Wrangler config", () => {
    cloudflareAdapter({ configPath: "./.void-wrangler.jsonc" }).vitePlugins?.();

    expect(cloudflare).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { main: "virtual:pracht/server" },
        configPath: "./.void-wrangler.jsonc",
      }),
    );
  });
});
