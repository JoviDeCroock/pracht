import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";

function serve(
  middleware: (args: unknown, next: () => Promise<Response>) => Promise<Response>,
  headers?: Record<string, string>,
) {
  return handlePrachtRequest({
    app: defineApp({
      middleware: { wrap: "./middleware/wrap.ts" },
      routes: [route("/", "./routes/home.tsx", { middleware: ["wrap"] })],
    }),
    registry: {
      middlewareModules: { "./middleware/wrap.ts": async () => ({ middleware }) },
      routeModules: {
        "./routes/home.tsx": async () => ({ Component: () => null, loader: () => ({ ok: true }) }),
      },
    },
    request: new Request("http://localhost/", { headers }),
  });
}

describe("framework-built page responses", () => {
  it("leave the pipeline as the response the render produced", async () => {
    let rendered: Response | undefined;
    const response = await serve(async (_args, next) => (rendered = await next()));

    // Route headers used to be applied to a fresh copy: a second Headers and
    // Response for every document.
    expect(response).toBe(rendered);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("vary")).toContain("x-pracht-route-state-request");
  });

  it("is the same for route-state responses", async () => {
    let rendered: Response | undefined;
    const response = await serve(async (_args, next) => (rendered = await next()), {
      "x-pracht-route-state-request": "1",
    });

    expect(response).toBe(rendered);
    expect(response.headers.get("cache-control")).toBeTruthy();
    expect(await response.json()).toMatchObject({ data: { ok: true } });
  });

  it("still restore a default security header middleware removed", async () => {
    const response = await serve(async (_args, next) => {
      const rendered = await next();
      rendered.headers.delete("x-frame-options");
      return rendered;
    });

    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});
