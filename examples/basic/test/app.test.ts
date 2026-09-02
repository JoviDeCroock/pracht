import { describe, expect, it } from "vitest";
import {
  createApiArgs,
  createLoaderArgs,
  createMiddlewareArgs,
  readJson,
  readRedirect,
  runMiddleware,
} from "@pracht/test";

import { POST as dashboardPost } from "../src/api/dashboard.ts";
import { POST as echoPost } from "../src/api/echo.ts";
import { middleware as auth } from "../src/middleware/auth.ts";
import { sessions } from "../src/server/session.ts";
import { loader as productLoader } from "../src/routes/product.tsx";

// Dogfood tests: the example app's real middleware, loader, and API handlers
// tested with @pracht/test — imported from the built package, the way an app
// developer consumes it.

describe("auth middleware", () => {
  it("redirects anonymous requests to the login page with a return path", async () => {
    const response = await runMiddleware(auth, createMiddlewareArgs({ url: "/dashboard" }));
    expect(readRedirect(response)).toEqual({
      status: 302,
      location: "/login?redirect=%2Fdashboard",
    });
  });

  it("rejects a cookie that was not sealed by the app", async () => {
    const response = await runMiddleware(
      auth,
      createMiddlewareArgs({ url: "/dashboard", headers: { cookie: "__Host-session=abc" } }),
      async () => new Response("dashboard"),
    );
    expect(readRedirect(response)?.status).toBe(302);
  });

  it("passes requests with a signed-in session through to the handler", async () => {
    const storage = sessions();
    const session = await storage.getSession(null);
    session.set("userId", "u_1");
    session.set("email", "ada@example.com");
    session.set("name", "Ada");
    const cookie = (await storage.commitSession(session)).split(";")[0];

    const response = await runMiddleware(
      auth,
      createMiddlewareArgs({ url: "/dashboard", headers: { cookie } }),
      async () => new Response("dashboard"),
    );
    expect(await response.text()).toBe("dashboard");
  });
});

describe("product loader", () => {
  it("resolves a prerendered product from params", () => {
    const data = productLoader(
      createLoaderArgs({ url: "/products/1", params: { productId: "1" } }),
    );
    expect(data).toMatchObject({ id: "1", name: "Widget" });
  });

  it("throws notFound() for an unknown product id", () => {
    expect(() =>
      productLoader(createLoaderArgs({ url: "/products/999", params: { productId: "999" } })),
    ).toThrow(
      expect.objectContaining({ name: "PrachtHttpError", status: 404 }) as unknown as Error,
    );
  });
});

describe("API handlers", () => {
  it("echoes a JSON body", async () => {
    const response = await echoPost(createApiArgs({ url: "/api/echo", body: { hello: "pracht" } }));
    expect(await readJson(response)).toEqual({ echo: { hello: "pracht" } });
  });

  it("redirects the dashboard POST when ?redirect is present", async () => {
    const response = await dashboardPost(
      createApiArgs({ url: "/api/dashboard?redirect", method: "POST" }),
    );
    expect(readRedirect(response)).toEqual({ status: 302, location: "http://localhost/" });
  });

  it("saves without the redirect flag", async () => {
    const response = await dashboardPost(createApiArgs({ url: "/api/dashboard", method: "POST" }));
    expect(await readJson(response)).toEqual({ saved: true });
  });
});
