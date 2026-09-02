/**
 * Cookie sessions: the data itself travels in the (encrypted, authenticated)
 * cookie. These cover the security properties the format has to hold —
 * confidentiality, tamper rejection, expiry, rotation, and the size ceiling
 * browsers enforce by silently dropping the cookie.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionStorage } from "../src/index.ts";
import { cookieAttribute, OTHER_SECRET, SECRET, toCookieHeader } from "./helpers.ts";

interface AppSession extends Record<string, unknown> {
  userId: string;
  email: string;
  theme: string;
}

function storage(secrets: string[] = [SECRET]) {
  return createSessionStorage<AppSession>({ cookie: { name: "session", secrets } });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("round trip", () => {
  it("carries values across requests", async () => {
    const sessions = storage();
    const first = await sessions.getSession(null);
    first.set("userId", "u_1");
    first.set("email", "ada@example.com");
    const setCookie = await sessions.commitSession(first);

    const second = await sessions.getSession(toCookieHeader(setCookie));
    expect(second.get("userId")).toBe("u_1");
    expect(second.get("email")).toBe("ada@example.com");
    expect(second.id).toBe(first.id);
  });

  it("does not put the session data in the cookie in readable form", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("email", "ada@example.com");
    const setCookie = await sessions.commitSession(session);

    // The whole point of encrypting rather than only signing: neither the
    // plaintext nor its base64 shows up in the cookie jar.
    expect(setCookie).not.toContain("ada@example.com");
    expect(setCookie).not.toContain(btoa("ada@example.com"));
  });

  it("reports dirtiness so an untouched session emits no Set-Cookie", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    expect(sessions.isDirty(session)).toBe(false);

    session.set("userId", "u_1");
    expect(sessions.isDirty(session)).toBe(true);

    await sessions.commitSession(session);
    expect(sessions.isDirty(session)).toBe(false);
  });

  it("keeps unset/has/data consistent", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    session.set("theme", "dark");
    expect(session.has("userId")).toBe(true);
    expect(session.data).toEqual({ userId: "u_1", theme: "dark" });

    session.unset("userId");
    expect(session.has("userId")).toBe(false);
    expect(session.get("userId")).toBeUndefined();
    expect(session.data).toEqual({ theme: "dark" });
  });

  it("does not let a mutation of the data snapshot reach the session", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("theme", "dark");

    (session.data as Record<string, unknown>).theme = "light";
    expect(session.get("theme")).toBe("dark");
  });
});

describe("tampering", () => {
  it("rejects a cookie whose ciphertext was edited", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(session));

    // Flip a character in the sealed value. AES-GCM's tag check fails, and a
    // failed open is indistinguishable from no cookie at all.
    const flipped = cookie.replace(/(.)$/, (last) => (last === "A" ? "B" : "A"));
    const tampered = await sessions.getSession(flipped);
    expect(tampered.get("userId")).toBeUndefined();
    expect(tampered.id).not.toBe(session.id);
  });

  it("rejects a cookie sealed with a secret the storage does not know", async () => {
    const attacker = storage([OTHER_SECRET]);
    const forged = await attacker.getSession(null);
    forged.set("userId", "admin");
    const cookie = toCookieHeader(await attacker.commitSession(forged));

    const victim = storage([SECRET]);
    expect((await victim.getSession(cookie)).get("userId")).toBeUndefined();
  });

  it("rejects a payload sealed for a different cookie name", async () => {
    // Same secret, different cookie. Without the name binding inside the
    // sealed payload, this value would decrypt and be accepted.
    const other = createSessionStorage<AppSession>({
      cookie: { name: "other_session", secrets: [SECRET] },
    });
    const session = await other.getSession(null);
    session.set("userId", "u_1");
    const value = (await other.commitSession(session)).split(";")[0].split("=").slice(1).join("=");

    const sessions = storage();
    expect((await sessions.getSession(`session=${value}`)).get("userId")).toBeUndefined();
  });

  it("rejects garbage and truncated values without throwing", async () => {
    const sessions = storage();
    for (const value of ["", "not-a-token", "v1.", "v1.!!!!", "v2.AAAA", "v1.AAAA"]) {
      const session = await sessions.getSession(`session=${value}`);
      expect(session.data).toEqual({});
    }
  });
});

describe("expiry", () => {
  it("refuses a session past the expiry sealed into the payload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 60 },
    });
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(session));

    vi.setSystemTime(new Date("2026-01-01T00:00:59Z"));
    expect((await sessions.getSession(cookie)).get("userId")).toBe("u_1");

    // Past `maxAge`. `Max-Age` on the cookie is only a request to the client;
    // the payload's own expiry is what actually ends the session.
    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    expect((await sessions.getSession(cookie)).get("userId")).toBeUndefined();
  });

  it("rolls the expiry forward on every commit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 60 },
    });
    const first = await sessions.getSession(null);
    first.set("userId", "u_1");
    let cookie = toCookieHeader(await sessions.commitSession(first));

    vi.setSystemTime(new Date("2026-01-01T00:00:50Z"));
    const second = await sessions.getSession(cookie);
    second.set("theme", "dark");
    cookie = toCookieHeader(await sessions.commitSession(second));

    vi.setSystemTime(new Date("2026-01-01T00:01:30Z"));
    expect((await sessions.getSession(cookie)).get("userId")).toBe("u_1");
  });

  it("honours a per-commit maxAge override", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const setCookie = await sessions.commitSession(session, { maxAge: 60 * 60 * 24 * 30 });
    expect(cookieAttribute(setCookie, "Max-Age")).toBe(String(60 * 60 * 24 * 30));
  });
});

describe("secret rotation", () => {
  it("reads cookies sealed with an older secret and re-seals with the newest", async () => {
    const old = storage([OTHER_SECRET]);
    const session = await old.getSession(null);
    session.set("userId", "u_1");
    const oldCookie = toCookieHeader(await old.commitSession(session));

    // Deploy: the new secret goes first, the old one stays for verification.
    const rotated = storage([SECRET, OTHER_SECRET]);
    const carried = await rotated.getSession(oldCookie);
    expect(carried.get("userId")).toBe("u_1");

    carried.set("theme", "dark");
    const newCookie = toCookieHeader(await rotated.commitSession(carried));

    // The re-sealed cookie opens under the new secret alone, so the old one
    // can be dropped on the next deploy without logging anybody out.
    expect((await storage([SECRET]).getSession(newCookie)).get("userId")).toBe("u_1");
    // ...and the old secret alone can no longer open it.
    expect((await storage([OTHER_SECRET]).getSession(newCookie)).get("userId")).toBeUndefined();
  });
});

describe("size guard", () => {
  it("throws a directive error instead of emitting a cookie browsers drop", async () => {
    const sessions = createSessionStorage<Record<string, unknown>>({
      cookie: { name: "session", secrets: [SECRET] },
    });
    const session = await sessions.getSession(null);
    session.set("blob", "x".repeat(5000));

    await expect(sessions.commitSession(session)).rejects.toThrow(/4096-byte limit/);
    await expect(sessions.commitSession(session)).rejects.toThrow(/pass a `store`/);
  });

  it("allows a payload that fits", async () => {
    const sessions = createSessionStorage<Record<string, unknown>>({
      cookie: { name: "session", secrets: [SECRET] },
    });
    const session = await sessions.getSession(null);
    session.set("blob", "x".repeat(1000));
    await expect(sessions.commitSession(session)).resolves.toContain("session=");
  });
});

describe("cookie attributes", () => {
  it("is HttpOnly, SameSite=Lax, Path=/ by default", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const setCookie = await sessions.commitSession(session);

    expect(cookieAttribute(setCookie, "HttpOnly")).toBe(true);
    expect(cookieAttribute(setCookie, "SameSite")).toBe("Lax");
    expect(cookieAttribute(setCookie, "Path")).toBe("/");
  });

  it("adds Secure for https and for plain http on a non-local host", async () => {
    const sessions = storage();

    for (const url of [
      "https://example.com/",
      // The failure this guards: a TLS-terminating proxy in front of the Node
      // adapter (which defaults to `trustProxy: false`) makes a production
      // request look like plain http. Inferring "not https, so not Secure"
      // there would strip the attribute on exactly the deployments that need
      // it, so anything that is not plainly local dev gets Secure.
      "http://example.com/",
      "http://10.0.0.7:8080/",
      "http://myapp.internal/",
    ]) {
      const session = await sessions.getSession(new Request(url));
      session.set("userId", "u_1");
      expect(cookieAttribute(await sessions.commitSession(session), "Secure"), url).toBe(true);
    }
  });

  it("omits Secure only for local http development", async () => {
    const sessions = storage();

    for (const url of [
      "http://localhost:3000/",
      "http://app.localhost:3000/",
      "http://127.0.0.1:5173/",
      "http://[::1]:5173/",
    ]) {
      const session = await sessions.getSession(new Request(url));
      session.set("userId", "u_1");
      expect(cookieAttribute(await sessions.commitSession(session), "Secure"), url).toBe(false);
    }
  });

  it("fails closed when there is no request to judge", async () => {
    // A raw Cookie header or `null` carries no scheme. Guessing "insecure"
    // would silently downgrade every caller that reads a session outside a
    // request (a job, a test, a capability).
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    expect(cookieAttribute(await sessions.commitSession(session), "Secure")).toBe(true);
  });

  it("honours an explicit `secure: false` for non-localhost http dev", async () => {
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], secure: false },
    });
    const session = await sessions.getSession(new Request("http://staging.internal/"));
    session.set("userId", "u_1");
    expect(cookieAttribute(await sessions.commitSession(session), "Secure")).toBe(false);
  });

  it("lets `secure` be forced, for TLS terminated upstream", async () => {
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], secure: true },
    });
    const session = await sessions.getSession(new Request("http://internal:8080/"));
    session.set("userId", "u_1");
    expect(cookieAttribute(await sessions.commitSession(session), "Secure")).toBe(true);
  });

  it("forces Secure for SameSite=None, which browsers require", async () => {
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], sameSite: "None" },
    });
    // Even on localhost, where the attribute would otherwise be dropped.
    const session = await sessions.getSession(new Request("http://localhost/"));
    session.set("userId", "u_1");
    const setCookie = await sessions.commitSession(session);
    expect(cookieAttribute(setCookie, "SameSite")).toBe("None");
    expect(cookieAttribute(setCookie, "Secure")).toBe(true);
  });

  it('refuses `sameSite: "None"` with an explicit `secure: false`', () => {
    // Silently overriding the option would leave the developer believing they
    // had a non-Secure cookie; the browser would just discard it.
    expect(() =>
      createSessionStorage({
        cookie: { name: "session", secrets: [SECRET], sameSite: "None", secure: false },
      }),
    ).toThrow(/cannot be honoured/);
  });

  it("passes through domain, path, and httpOnly overrides", async () => {
    const sessions = createSessionStorage<AppSession>({
      cookie: {
        name: "session",
        secrets: [SECRET],
        domain: "example.com",
        path: "/app",
        httpOnly: false,
        sameSite: "Strict",
      },
    });
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const setCookie = await sessions.commitSession(session);

    expect(cookieAttribute(setCookie, "Domain")).toBe("example.com");
    expect(cookieAttribute(setCookie, "Path")).toBe("/app");
    expect(cookieAttribute(setCookie, "HttpOnly")).toBe(false);
    expect(cookieAttribute(setCookie, "SameSite")).toBe("Strict");
  });
});

describe("configuration validation", () => {
  it("rejects missing, empty, and too-short secrets", () => {
    expect(() => createSessionStorage({ cookie: { name: "session", secrets: [] } })).toThrow(
      /at least one secret/,
    );
    expect(() => createSessionStorage({ cookie: { name: "session", secrets: ["short"] } })).toThrow(
      /16 characters/,
    );
  });

  it("rejects attribute values that could smuggle a second cookie attribute", () => {
    expect(() => createSessionStorage({ cookie: { name: "a b", secrets: [SECRET] } })).toThrow(
      /invalid cookie name/,
    );
    expect(() =>
      createSessionStorage({ cookie: { secrets: [SECRET], path: "/a; Domain=evil.test" } }),
    ).toThrow(/invalid cookie path/);
    expect(() =>
      createSessionStorage({ cookie: { secrets: [SECRET], domain: "evil.test; Secure" } }),
    ).toThrow(/invalid cookie domain/);
  });

  it("rejects a non-positive maxAge", () => {
    expect(() => createSessionStorage({ cookie: { secrets: [SECRET], maxAge: 0 } })).toThrow(
      /positive integer/,
    );
  });
});

describe("cross-storage safety", () => {
  it("refuses to commit a session created by a different storage", async () => {
    const a = storage();
    const b = storage();
    const session = await a.getSession(null);
    await expect(b.commitSession(session)).rejects.toThrow(/not created by this storage/);
  });
});
