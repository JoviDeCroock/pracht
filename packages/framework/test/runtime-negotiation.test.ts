import { describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import { markdownResponse, prefersMarkdown } from "../src/runtime-negotiation.ts";

describe("prefersMarkdown", () => {
  it("returns false when the header is absent or empty", () => {
    expect(prefersMarkdown(null)).toBe(false);
    expect(prefersMarkdown("")).toBe(false);
  });

  it("returns false for browsers sending */*", () => {
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(prefersMarkdown("text/html,*/*")).toBe(false);
  });

  it("returns true for explicit text/markdown", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
  });

  it("respects q-values", () => {
    expect(prefersMarkdown("text/html;q=0.9, text/markdown;q=1.0")).toBe(true);
    expect(prefersMarkdown("text/markdown;q=0.5, text/html;q=0.9")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0")).toBe(false);
  });
});

describe("markdownResponse", () => {
  it("returns markdown with Accept in Vary", () => {
    const response = markdownResponse("# hello");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept");
  });
});

describe("handlePrachtRequest markdown negotiation", () => {
  const app = defineApp({
    routes: [route("/", "./routes/home.md")],
  });

  it("returns markdown source when the client prefers it", async () => {
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.md": async () => ({
            markdown: "# Home\n",
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { accept: "text/markdown" },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await response.text()).toBe("# Home\n");
  });

  it("still renders HTML when the client only sends */*", async () => {
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.md": async () => ({
            markdown: "# Home\n",
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { accept: "text/html,*/*" },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.includes("text/html")).toBe(true);
    expect(response.headers.get("vary")?.toLowerCase()).toContain("accept");
  });

  it("falls through to HTML when the route has no markdown export", async () => {
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.md": async () => ({
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { accept: "text/markdown" },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.includes("text/html")).toBe(true);
    expect(response.headers.get("vary")?.toLowerCase()).not.toContain("accept");
  });

  it("runs loader and preserves document headers before returning markdown", async () => {
    let loaderCalls = 0;
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.md": async () => ({
            markdown: "# Home\n",
            loader: () => {
              loaderCalls += 1;
              return { ok: true };
            },
            headers: () => ({
              "cache-control": "private, no-store",
              "x-route-headers": "yes",
            }),
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { accept: "text/markdown" },
      }),
    });

    expect(loaderCalls).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-route-headers")).toBe("yes");
    expect(await response.text()).toBe("# Home\n");
  });
});
