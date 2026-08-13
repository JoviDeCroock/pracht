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
import { loader as productLoader } from "../src/routes/product.tsx";

// Dogfood tests: the example app's real middleware, loader, and API handlers
// tested with @pracht/test — imported from the built package, the way an app
// developer consumes it.

describe("auth middleware", () => {
  it("redirects anonymous requests to /", async () => {
    const response = await runMiddleware(auth, createMiddlewareArgs({ url: "/dashboard" }));
    expect(readRedirect(response)).toEqual({ status: 302, location: "/" });
  });

  it("passes requests with a session cookie through to the handler", async () => {
    const response = await runMiddleware(
      auth,
      createMiddlewareArgs({ url: "/dashboard", headers: { cookie: "session=abc" } }),
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
