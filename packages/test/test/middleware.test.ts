import type { MiddlewareFn } from "@pracht/core";
import { notFound, redirect } from "@pracht/core";
import { describe, expect, it } from "vitest";

import {
  createApiMiddlewareArgs,
  createMiddlewareArgs,
  readRedirect,
  runMiddleware,
} from "../src/index.ts";

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

  it("isolates top-level args replacement between middleware like production", async () => {
    type Ctx = { user?: string };
    const seen: Array<{ context: Ctx; path: string }> = [];

    const replaceWrapperFields: MiddlewareFn<Ctx> = async (args, next) => {
      args.context = { user: "replacement" };
      args.url = new URL("http://localhost/replacement");
      return next();
    };
    const inspectDownstream: MiddlewareFn<Ctx> = async ({ context, url }, next) => {
      seen.push({ context, path: url.pathname });
      return next();
    };

    const args = createMiddlewareArgs<Ctx>({ context: {}, url: "/dashboard" });
    const originalUrl = args.url;
    await runMiddleware([replaceWrapperFields, inspectDownstream], args);

    expect(seen).toEqual([{ context: args.context, path: "/dashboard" }]);
    expect(args.url).toBe(originalUrl);
  });

  it("runs API middleware with the same route metadata shape as production", async () => {
    const inspectRoute: MiddlewareFn = async ({ route }, next) => {
      expect(route.path).toBe("/api/health");
      expect("middlewareFiles" in route).toBe(false);
      return next();
    };

    const response = await runMiddleware(
      inspectRoute,
      createApiMiddlewareArgs({ url: "/api/health" }),
    );
    expect(response.status).toBe(200);
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

  it("resolves a thrown Response as page/API outer dispatch does", async () => {
    // The `requireUser()` pattern: a shared helper throws redirect() where
    // the return value cannot escape from. The server treats the thrown
    // Response as the answer; runMiddleware must match.
    const gate: MiddlewareFn = async ({ request }, next) => {
      if (!request.headers.get("cookie")) throw redirect("/login", { request });
      return next();
    };

    const response = await runMiddleware(gate, createMiddlewareArgs({ url: "/dashboard" }));
    expect(readRedirect(response)).toEqual({ status: 302, location: "/login" });
  });

  it("unwinds a thrown Response past upstream middleware without running their decoration", async () => {
    let decorated = false;
    const timing: MiddlewareFn = async (_args, next) => {
      const response = await next();
      decorated = true;
      return response;
    };
    const throwing: MiddlewareFn = async () => {
      throw redirect("/login");
    };

    const response = await runMiddleware([timing, throwing], createMiddlewareArgs());
    expect(readRedirect(response).location).toBe("/login");
    expect(decorated).toBe(false);
  });

  it("resolves a Response thrown by the final handler", async () => {
    const passthrough: MiddlewareFn = async (_args, next) => next();
    const response = await runMiddleware(passthrough, createMiddlewareArgs(), () => {
      throw redirect("/done", 303);
    });
    expect(readRedirect(response)).toEqual({ status: 303, location: "/done" });
  });

  it("can reject a thrown Response for raw capability-chain semantics", async () => {
    const throwing: MiddlewareFn = async () => {
      throw redirect("/login");
    };

    await expect(
      runMiddleware(throwing, createMiddlewareArgs(), undefined, { thrownResponse: "reject" }),
    ).rejects.toBeInstanceOf(Response);
  });

  it("still rejects thrown non-Response errors, including notFound()", async () => {
    const missing: MiddlewareFn = async () => {
      throw notFound();
    };
    await expect(runMiddleware(missing, createMiddlewareArgs())).rejects.toMatchObject({
      name: "PrachtHttpError",
      status: 404,
    });
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
