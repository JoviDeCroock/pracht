import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function renderUnderBase(requestPath: string): Promise<string> {
  vi.resetModules();
  vi.stubEnv("BASE_URL", "/app/");
  const core = await import("../src/index.ts");
  const server = await import("../src/server.ts");
  const app = core.defineApp({
    routes: [core.route("/about", "./routes/about.tsx", { id: "about", render: "ssr" })],
  });

  const response = await server.handlePrachtRequest({
    app,
    request: new Request(`http://upstream${requestPath}`),
    registry: {
      routeModules: {
        "/src/routes/about.tsx": async () => ({
          Component: () => h("main", null, core.useLocation().pathname),
        }),
      },
    },
  });
  expect(response.status).toBe(200);
  return response.text();
}

describe("server runtime under a deploy base", () => {
  it("restores the browser base after a reverse proxy strips it", async () => {
    const html = await renderUnderBase("/about?ref=campaign");

    expect(html).toContain("<main>/app/about</main>");
    expect(html).toContain('"url":"/app/about?ref=campaign"');
  });

  it("does not duplicate a base that the upstream request retained", async () => {
    const html = await renderUnderBase("/app/about?ref=campaign");

    expect(html).toContain("<main>/app/about</main>");
    expect(html).toContain('"url":"/app/about?ref=campaign"');
    expect(html).not.toContain("/app/app/about");
  });
});
