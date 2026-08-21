import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function renderUnderBase(
  requestPath: string,
  options: {
    basePathStripped?: boolean;
    expectedStatus?: number;
    observedUrls?: string[];
    routePath?: string;
  } = {},
): Promise<string> {
  vi.resetModules();
  vi.stubEnv("BASE_URL", "/app/");
  const core = await import("../src/index.ts");
  const server = await import("../src/server.ts");
  const app = core.defineApp({
    routes: [
      core.route(options.routePath ?? "/about", "./routes/about.tsx", {
        id: "about",
        render: "ssr",
      }),
    ],
  });

  const response = await server.handlePrachtRequest({
    app,
    basePathStripped: options.basePathStripped,
    request: new Request(`http://upstream${requestPath}`),
    registry: {
      routeModules: {
        "/src/routes/about.tsx": async () => ({
          Component: () => h("main", null, core.useLocation().pathname),
          ...(options.observedUrls
            ? {
                loader: ({ request, url }: { request: Request; url: URL }) => {
                  options.observedUrls?.push(request.url, url.href);
                  return null;
                },
              }
            : {}),
        }),
      },
    },
  });
  expect(response.status).toBe(options.expectedStatus ?? 200);
  return response.text();
}

describe("server runtime under a deploy base", () => {
  it("keeps root-absolute redirect helper targets inside the deploy base", async () => {
    vi.resetModules();
    vi.stubEnv("BASE_URL", "/app/");
    const { redirect } = await import("../src/index.ts");

    expect(redirect("/login").headers.get("location")).toBe("/app/login");
    expect(redirect("login").headers.get("location")).toBe("login");
    expect(redirect("//auth.example/login").headers.get("location")).toBe("//auth.example/login");
    expect(redirect("https://auth.example/login").headers.get("location")).toBe(
      "https://auth.example/login",
    );
  });

  it("requires an explicit contract for a proxy-stripped request", async () => {
    const html = await renderUnderBase("/about?ref=campaign", { expectedStatus: 404 });

    expect(html).toBe("Not found");
  });

  it("restores the browser base after a reverse proxy strips it", async () => {
    const observedUrls: string[] = [];
    const html = await renderUnderBase("/about?ref=campaign", {
      basePathStripped: true,
      observedUrls,
    });

    expect(html).toContain("<main>/app/about</main>");
    expect(html).toContain('"url":"/app/about?ref=campaign"');
    expect(observedUrls).toEqual([
      "http://upstream/app/about?ref=campaign",
      "http://upstream/app/about?ref=campaign",
    ]);
  });

  it("does not duplicate a base that the upstream request retained", async () => {
    const html = await renderUnderBase("/app/about?ref=campaign");

    expect(html).toContain("<main>/app/about</main>");
    expect(html).toContain('"url":"/app/about?ref=campaign"');
    expect(html).not.toContain("/app/app/about");
  });

  it("does not strip a base-like first route segment from rewritten requests", async () => {
    const html = await renderUnderBase("/app/about?ref=campaign", {
      basePathStripped: true,
      routePath: "/app/about",
    });

    expect(html).toContain("<main>/app/app/about</main>");
    expect(html).toContain('"url":"/app/app/about?ref=campaign"');
  });
});
