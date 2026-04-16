import { describe, expect, it } from "vitest";

import { parseSafeNavigationUrl } from "../src/runtime.ts";

const BASE = "https://example.com/page";

describe("parseSafeNavigationUrl", () => {
  it("accepts same-origin absolute paths", () => {
    const url = parseSafeNavigationUrl("/dashboard", BASE);
    expect(url?.toString()).toBe("https://example.com/dashboard");
  });

  it("accepts relative paths", () => {
    const url = parseSafeNavigationUrl("../other", BASE);
    expect(url?.origin).toBe("https://example.com");
  });

  it("accepts http and https cross-origin URLs", () => {
    expect(parseSafeNavigationUrl("https://trusted.example/", BASE)?.protocol).toBe("https:");
    expect(parseSafeNavigationUrl("http://plain.example/", BASE)?.protocol).toBe("http:");
  });

  it("rejects javascript: URLs", () => {
    expect(parseSafeNavigationUrl("javascript:alert(1)", BASE)).toBeNull();
    expect(parseSafeNavigationUrl("JaVaScRiPt:alert(1)", BASE)).toBeNull();
  });

  it("rejects data: URLs", () => {
    expect(parseSafeNavigationUrl("data:text/html,<script>alert(1)</script>", BASE)).toBeNull();
  });

  it("rejects vbscript: URLs", () => {
    expect(parseSafeNavigationUrl("vbscript:msgbox(1)", BASE)).toBeNull();
  });

  it("rejects file: URLs", () => {
    expect(parseSafeNavigationUrl("file:///etc/passwd", BASE)).toBeNull();
  });

  it("rejects blob: URLs", () => {
    expect(parseSafeNavigationUrl("blob:https://example.com/uuid", BASE)).toBeNull();
  });

  it("returns null for unparseable inputs", () => {
    expect(parseSafeNavigationUrl("http://[::1", BASE)).toBeNull();
  });

  it("tolerates leading/trailing whitespace the URL parser would accept", () => {
    expect(parseSafeNavigationUrl(" /foo ", BASE)?.pathname).toBe("/foo");
  });
});
