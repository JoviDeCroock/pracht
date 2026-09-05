/**
 * Base64url canonicality.
 *
 * `atob` ignores the unused low bits of the final character, so for most
 * payload lengths several distinct strings decode to identical bytes. Left
 * alone, that makes a sealed cookie malleable in a way that changes the token
 * string without changing the session it opens — and anything keyed on the
 * cookie string (a cache, a revocation list, a log correlation) sees two
 * different tokens for one session.
 */
import { describe, expect, it } from "vitest";

import { fromBase64Url, toBase64Url } from "../src/crypto.ts";
import { createSessionStorage } from "../src/index.ts";
import { SECRET, toCookieHeader } from "./helpers.ts";

describe("fromBase64Url", () => {
  it("round-trips canonical encodings", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      const encoded = toBase64Url(bytes);
      expect(fromBase64Url(encoded), encoded).toEqual(bytes);
    }
  });

  it("rejects a non-canonical final character", () => {
    // One byte encodes to two characters carrying 12 bits, of which only the
    // top 8 matter. "AA" and "AB" both decode to [0x00]; only "AA" is
    // canonical.
    expect(fromBase64Url("AA")).toEqual(new Uint8Array([0]));
    expect(fromBase64Url("AB")).toBeNull();
    expect(fromBase64Url("AP")).toBeNull();

    // Two bytes encode to three characters carrying 18 bits, six unused.
    expect(fromBase64Url("AAA")).toEqual(new Uint8Array([0, 0]));
    expect(fromBase64Url("AAB")).toBeNull();
  });

  it("rejects padding and non-alphabet characters", () => {
    expect(fromBase64Url("AA==")).toBeNull();
    expect(fromBase64Url("AA=")).toBeNull();
    expect(fromBase64Url("A+/B")).toBeNull();
    expect(fromBase64Url("hello world")).toBeNull();
    expect(fromBase64Url("A")).toBeNull();
  });

  it("accepts the empty string as zero bytes", () => {
    expect(fromBase64Url("")).toEqual(new Uint8Array(0));
  });
});

describe("session cookies reject non-canonical tokens", () => {
  it("refuses a mutated-but-equivalent final character", async () => {
    const sessions = createSessionStorage<{ userId: string }>({
      cookie: { name: "session", secrets: [SECRET] },
    });

    // Only a payload whose byte length is not a multiple of 3 leaves unused
    // bits in the last base64 character, so vary the payload until one does.
    let probe: { cookie: string; equivalent: string } | undefined;
    for (let length = 1; length < 8 && probe === undefined; length += 1) {
      const session = await sessions.getSession(null);
      session.set("userId", "u".repeat(length));
      const cookie = toCookieHeader(await sessions.commitSession(session));
      const equivalent = nonCanonicalVariant(decodeURIComponent(cookie.slice("session=".length)));
      if (equivalent !== undefined) probe = { cookie, equivalent };
    }

    expect(probe, "expected a sealed value with slack in its last character").toBeDefined();
    const { cookie, equivalent } = probe as { cookie: string; equivalent: string };

    // The canonical token opens.
    expect((await sessions.getSession(cookie)).get("userId")).toMatch(/^u+$/);

    // The variant decodes to byte-identical ciphertext, so AES-GCM alone would
    // accept it. The canonicality check is what turns it into "no session".
    expect((await sessions.getSession(`session=${equivalent}`)).get("userId")).toBeUndefined();
  });
});

/**
 * A different `v1.<base64url>` string that decodes to the same bytes, or
 * `undefined` when the encoding has no unused trailing bits.
 */
function nonCanonicalVariant(token: string): string | undefined {
  const separator = token.indexOf(".");
  const prefix = token.slice(0, separator + 1);
  const value = token.slice(separator + 1);
  const canonical = fromBase64Url(value);
  if (canonical === null) return undefined;

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (const character of alphabet) {
    const candidate = value.slice(0, -1) + character;
    if (candidate === value) continue;
    const decoded = decodeLenient(candidate);
    if (decoded !== null && sameBytes(decoded, canonical)) return prefix + candidate;
  }
  return undefined;
}

/** `atob`-style decode without the canonicality check, for the test above. */
function decodeLenient(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
