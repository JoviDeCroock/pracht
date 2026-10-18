import { describe, expect, it } from "vitest";

import { base64UrlEncode } from "../src/server/base64url.ts";

describe("base64UrlEncode", () => {
  it("uses the URL-safe alphabet without padding", () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
    expect(base64UrlEncode(new Uint8Array([0x66]))).toBe("Zg");
    expect(base64UrlEncode(new Uint8Array([]))).toBe("");
  });
});
