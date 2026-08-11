import type { MiddlewareFn } from "@pracht/core";
import { redirect } from "@pracht/core";
import { describe, expect, it } from "vitest";

import { createMiddlewareArgs, readRedirect, runMiddleware } from "../src/index.ts";

describe("runMiddleware", () => {
  it("runs a single middleware through to the final handler", async () => {
    const middleware: MiddlewareFn = async (_args, next) => next();

    const response = await runMiddleware(middleware, createMiddlewareArgs());
    expect(response.status).toBe(200);
  });

  it("returns the final handler's response", async () => {
    const middleware: MiddlewareFn = async (_args, next) => next();

    const response = await runMiddleware(middleware, createMiddlewareArgs(), () =>
      Response.json({ from: "handler" }, { status: 201 }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ from: "handler" });
  });

  it("short-circuits when a middleware returns without calling next()", async () => {
    const auth: MiddlewareFn = async ({ request }, next) => {
      if (!request.headers.get("cookie")?.includes("session=")) {
        return redirect("/login", { request });
      }
      return next();
    };
    let handlerRan = false;

    const denied = await runMiddleware(auth, createMiddlewareArgs({ url: "/dashboard" }), () => {
      handlerRan = true;
      return Promise.resolve(new Response("secret"));
    });

    expect(handlerRan).toBe(false);
    expect(readRedirect(denied)).toEqual({ status: 302, location: "/login" });

    const allowed = await runMiddleware(
      auth,
      createMiddlewareArgs({ url: "/dashboard", headers: { cookie: "session=abc" } }),
      async () => new Response("secret"),
    );
    expect(await allowed.text()).toBe("secret");
  });

  it("runs a chain in order and shares context mutations downstream", async () => {
    const order: string[] = [];
    type Ctx = { user?: string };

    const first: MiddlewareFn<Ctx> = async ({ context }, next) => {
      order.push("first:before");
      context.user = "user-1";
      const response = await next();
      order.push("first:after");
      return response;
    };
    const second: MiddlewareFn<Ctx> = async ({ context }, next) => {
      order.push(`second:${context.user}`);
      return next();
    };

    const response = await runMiddleware(
      [first, second],
      createMiddlewareArgs<Ctx>({ context: {} }),
      async () => {
        order.push("handler");
        return new Response("ok");
      },
    );

    expect(await response.text()).toBe("ok");
    expect(order).toEqual(["first:before", "second:user-1", "handler", "first:after"]);
  });

  it("lets upstream middleware decorate the final response", async () => {
    const timing: MiddlewareFn = async (_args, next) => {
      const response = await next();
      const decorated = new Response(response.body, response);
      decorated.headers.set("x-timing", "1ms");
      return decorated;
    };

    const response = await runMiddleware(timing, createMiddlewareArgs());
    expect(response.headers.get("x-timing")).toBe("1ms");
  });

  it("rejects a middleware that calls next() twice", async () => {
    const broken: MiddlewareFn = async (_args, next) => {
      await next();
      return next();
    };

    await expect(runMiddleware(broken, createMiddlewareArgs())).rejects.toThrow(
      /called next\(\) multiple times/,
    );
  });

  it("rejects a middleware that does not return a Response", async () => {
    const broken = (async () => "not a response") as unknown as MiddlewareFn;

    await expect(runMiddleware(broken, createMiddlewareArgs())).rejects.toThrow(
      /did not return a Response/,
    );
  });

  it("runs only the final handler for an empty chain", async () => {
    const response = await runMiddleware(
      [],
      createMiddlewareArgs(),
      async () => new Response("terminal"),
    );
    expect(await response.text()).toBe("terminal");
  });
});
