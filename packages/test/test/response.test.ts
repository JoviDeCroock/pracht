import { redirect } from "@pracht/core";
import { describe, expect, it } from "vitest";

import { readJson, readRedirect } from "../src/index.ts";

describe("readJson", () => {
  it("parses a JSON body", async () => {
    const response = Response.json({ items: [1, 2, 3] });
    expect(await readJson(response)).toEqual({ items: [1, 2, 3] });
  });

  it("leaves the original response readable", async () => {
    const response = Response.json({ ok: true });
    await readJson(response);
    // A second read (or the test's own response.json()) still works.
    expect(await response.json()).toEqual({ ok: true });
  });

  it("throws with the raw body when the payload is not JSON", async () => {
    const response = new Response("<html>oops</html>", { status: 500 });
    await expect(readJson(response)).rejects.toThrow(/status 500.*<html>oops<\/html>/);
  });
});

describe("readRedirect", () => {
  it("reads status and location from redirect() responses", () => {
    const response = redirect("/login");
    expect(readRedirect(response)).toEqual({ status: 302, location: "/login" });
  });

  it("respects explicit redirect statuses", () => {
    expect(readRedirect(redirect("/done", 301))).toEqual({ status: 301, location: "/done" });
  });

  it("throws for non-redirect responses", () => {
    expect(() => readRedirect(new Response("ok"))).toThrow(/Expected a redirect/);
  });

  it("throws for a 3xx without a Location header", () => {
    expect(() => readRedirect(new Response(null, { status: 302 }))).toThrow(/Location header/);
  });

  it("rejects 304 Not Modified as a non-redirect", () => {
    expect(() => readRedirect(new Response(null, { status: 304 }))).toThrow(
      /304 \(Not Modified is not a redirect\)/,
    );
  });
});
