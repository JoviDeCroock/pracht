import type { ApiRouteArgs, MiddlewareFn } from "@pracht/core";
import { describe, expect, it } from "vitest";

import {
  createApiArgs,
  createLoaderArgs,
  createMiddlewareArgs,
  runMiddleware,
} from "../src/index.ts";

describe("waitUntil on test args", () => {
  it("records registered work so a test can await it after the response", async () => {
    const sent: string[] = [];
    async function POST({ waitUntil }: ApiRouteArgs) {
      waitUntil(
        new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
          sent.push("welcome email");
        }),
      );
      return new Response(null, { status: 202 });
    }

    const args = createApiArgs({ url: "/api/signup", body: { email: "a@example.com" } });
    const response = await POST(args);

    expect(response.status).toBe(202);
    expect(args.waitUntilPromises).toHaveLength(1);
    expect(sent).toEqual([]);
    await args.flushWaitUntil();
    expect(sent).toEqual(["welcome email"]);
  });

  it("flushes work registered while flushing and rejects with the first failure", async () => {
    const args = createLoaderArgs();
    const order: string[] = [];
    args.waitUntil(
      Promise.resolve().then(() => {
        order.push("outer");
        args.waitUntil(Promise.reject(new Error("nested failed")));
      }),
    );

    await expect(args.flushWaitUntil()).rejects.toThrow("nested failed");
    expect(order).toEqual(["outer"]);
    expect(args.waitUntilPromises).toHaveLength(2);
  });

  it("does not surface an unflushed rejection as unhandled", async () => {
    const args = createLoaderArgs();
    args.waitUntil(Promise.reject(new Error("ignored by this test")));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(args.waitUntilPromises).toHaveLength(1);
  });

  it("forwards to a custom waitUntil and survives the per-middleware args copy", async () => {
    const forwarded: Promise<unknown>[] = [];
    const track: MiddlewareFn = (args, next) => {
      args.waitUntil(Promise.resolve("tracked"));
      return next();
    };
    const args = createMiddlewareArgs({ waitUntil: (promise) => forwarded.push(promise) });

    await runMiddleware(track, args);

    expect(args.waitUntilPromises).toHaveLength(1);
    expect(forwarded).toHaveLength(1);
    await args.flushWaitUntil();
  });
});
