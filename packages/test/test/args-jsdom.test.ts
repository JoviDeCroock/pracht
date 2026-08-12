// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { createTestRequest } from "../src/index.ts";

describe("request args in JSDOM", () => {
  it("streams a JSDOM Blob into Node's Request implementation", async () => {
    const request = createTestRequest({
      body: new Blob(["hello"], { type: "text/plain" }),
    });

    expect(request.headers.get("content-type")).toBe("text/plain");
    expect(await request.text()).toBe("hello");
  });

  it("normalizes JSDOM URLSearchParams with its form content type", async () => {
    const request = createTestRequest({
      body: new URLSearchParams({ query: "search term" }),
    });

    expect(request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    expect(new URLSearchParams(await request.text()).get("query")).toBe("search term");
  });
});
