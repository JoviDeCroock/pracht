import type { LoaderArgs } from "@pracht/core";
import { notFound, redirect } from "@pracht/core";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  createApiArgs,
  createApiMiddlewareArgs,
  createLoaderArgs,
  createMiddlewareArgs,
} from "../src/index.ts";

describe("createLoaderArgs", () => {
  it("builds complete LoaderArgs from no input", () => {
    const args = createLoaderArgs();

    expect(args.request).toBeInstanceOf(Request);
    expect(args.request.method).toBe("GET");
    expect(args.url.href).toBe("http://localhost/");
    expect(args.params).toEqual({});
    expect(args.signal).toBeInstanceOf(AbortSignal);
    expect(args.route.path).toBe("/");
    expect(args.route.middleware).toEqual([]);
    expect(args.route.middlewareFiles).toEqual([]);
    expect(args.route.segments).toEqual([]);
  });

  it("derives url and route path from the shorthand url", () => {
    const args = createLoaderArgs({ url: "/blog/hello?draft=1" });

    expect(args.request.url).toBe("http://localhost/blog/hello?draft=1");
    expect(args.url.pathname).toBe("/blog/hello");
    expect(args.url.searchParams.get("draft")).toBe("1");
    expect(args.route.path).toBe("/blog/hello");
  });

  it("accepts method, headers, and a JSON body shorthand", async () => {
    const args = createLoaderArgs({
      url: "/submit",
      headers: { "x-user-id": "user-1" },
      body: { name: "pracht" },
    });

    // A body without an explicit method defaults to POST.
    expect(args.request.method).toBe("POST");
    expect(args.request.headers.get("x-user-id")).toBe("user-1");
    expect(args.request.headers.get("content-type")).toBe("application/json");
    expect(await args.request.json()).toEqual({ name: "pracht" });
  });

  it("passes BodyInit bodies through unchanged", async () => {
    const args = createLoaderArgs({ method: "PUT", body: "raw text" });
    expect(args.request.method).toBe("PUT");
    expect(args.request.headers.get("content-type")).not.toBe("application/json");
    expect(await args.request.text()).toBe("raw text");
  });

  it("supports ReadableStream bodies (streaming uploads need duplex)", async () => {
    const stream = new Blob(["streamed"]).stream();
    const args = createLoaderArgs({ method: "POST", body: stream });
    expect(await args.request.text()).toBe("streamed");
  });

  it("preserves an ArrayBuffer created in another realm", async () => {
    const body = runInNewContext("new Uint8Array([65, 66, 67]).buffer") as ArrayBuffer;
    const args = createLoaderArgs({ body });

    expect(args.request.headers.get("content-type")).not.toBe("application/json");
    expect(await args.request.text()).toBe("ABC");
  });

  it("uses a real Request when given, ignoring the shorthand fields", () => {
    const request = new Request("http://example.com/real", { method: "DELETE" });
    const args = createLoaderArgs({ request, url: "/ignored", method: "GET" });

    expect(args.request).toBe(request);
    expect(args.url.href).toBe("http://example.com/real");
    expect(args.route.path).toBe("/real");
  });

  it("exposes the AbortController wired to args.signal", () => {
    const args = createLoaderArgs();
    expect(args.signal.aborted).toBe(false);
    args.controller.abort();
    expect(args.signal.aborted).toBe(true);
  });

  it("prefers an explicitly provided signal", () => {
    const external = new AbortController();
    const args = createLoaderArgs({ signal: external.signal });
    args.controller.abort();
    expect(args.signal.aborted).toBe(false);
    external.abort();
    expect(args.signal.aborted).toBe(true);
  });

  it("merges route overrides over the defaults", () => {
    const args = createLoaderArgs({
      url: "/blog/hello",
      route: { id: "blog-post", render: "ssg", file: "./routes/blog/[slug].tsx" },
    });

    expect(args.route.id).toBe("blog-post");
    expect(args.route.render).toBe("ssg");
    expect(args.route.file).toBe("./routes/blog/[slug].tsx");
    expect(args.route.path).toBe("/blog/hello");
  });

  it("feeds a real loader, including params, context, and thrown redirects", async () => {
    async function loader({ request, params, context }: LoaderArgs<{ users: string[] }>) {
      const user = request.headers.get("x-user-id");
      if (!user) throw redirect("/login", { request });
      if (!context.users.includes(user)) throw notFound();
      return { slug: params.slug, user };
    }

    const data = await loader(
      createLoaderArgs<{ users: string[] }>({
        url: "/blog/hello",
        params: { slug: "hello" },
        headers: { "x-user-id": "user-1" },
        context: { users: ["user-1"] },
      }),
    );
    expect(data).toEqual({ slug: "hello", user: "user-1" });

    await expect(
      loader(createLoaderArgs<{ users: string[] }>({ context: { users: [] } })),
    ).rejects.toBeInstanceOf(Response);
  });
});

describe("createMiddlewareArgs", () => {
  it("builds the same shape as LoaderArgs", () => {
    const args = createMiddlewareArgs({ url: "/dashboard" });
    expect(args.route.path).toBe("/dashboard");
    expect(args.route.middlewareFiles).toEqual([]);
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  it("builds API middleware args with runtime-faithful API route metadata", () => {
    const args = createApiMiddlewareArgs({
      url: "/api/users/42",
      params: { id: "42" },
      route: {
        path: "/api/users/:id",
        file: "./api/users/[id].ts",
        segments: [{ type: "static", value: "api" }],
      },
    });

    expect(args.route).toEqual({
      path: "/api/users/:id",
      file: "./api/users/[id].ts",
      segments: [{ type: "static", value: "api" }],
    });
    expect("middlewareFiles" in args.route).toBe(false);
    expect(args.params).toEqual({ id: "42" });
  });
});

describe("createApiArgs", () => {
  it("builds ApiRouteArgs with a ResolvedApiRoute", () => {
    const args = createApiArgs({ url: "/api/items" });

    expect(args.route.path).toBe("/api/items");
    expect(args.route.segments).toEqual([]);
    // API routes carry no page-route metadata.
    expect("middlewareFiles" in args.route).toBe(false);
  });

  it("merges api route overrides", () => {
    const args = createApiArgs({
      url: "/api/users/42",
      params: { id: "42" },
      route: { path: "/api/users/:id", file: "./api/users/[id].ts" },
    });

    expect(args.route.path).toBe("/api/users/:id");
    expect(args.params).toEqual({ id: "42" });
  });
});
