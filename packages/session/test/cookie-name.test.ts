/**
 * Cookie name prefixes and same-name duplicates — both about the fact that the
 * server does not fully control what arrives in a `Cookie` header. Anything
 * that can write a cookie for the host can add one, including one that shares
 * the session cookie's name.
 */
import { describe, expect, it } from "vitest";

import { createSessionStorage } from "../src/index.ts";
import { cookieAttribute, OTHER_SECRET, SECRET, toCookieHeader } from "./helpers.ts";

interface AppSession extends Record<string, unknown> {
  userId: string;
}

describe("__Host- prefix", () => {
  it("emits Secure, Path=/, and no Domain", async () => {
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "__Host-session", secrets: [SECRET] },
    });
    // Even on localhost http: the browser rejects a `__Host-` cookie without
    // the Secure attribute, so dropping it would break the cookie entirely.
    const session = await sessions.getSession(new Request("http://localhost:3000/"));
    session.set("userId", "u_1");
    const setCookie = await sessions.commitSession(session);

    expect(setCookie.startsWith("__Host-session=")).toBe(true);
    expect(cookieAttribute(setCookie, "Secure")).toBe(true);
    expect(cookieAttribute(setCookie, "Path")).toBe("/");
    expect(cookieAttribute(setCookie, "Domain")).toBe(false);
  });

  it("rejects a configured Domain", () => {
    expect(() =>
      createSessionStorage({
        cookie: { name: "__Host-session", secrets: [SECRET], domain: "example.com" },
      }),
    ).toThrow(/must be host-only/);
  });

  it("rejects a path other than /", () => {
    expect(() =>
      createSessionStorage({
        cookie: { name: "__Host-session", secrets: [SECRET], path: "/app" },
      }),
    ).toThrow(/must use `path: "\/"`/);
  });

  it("rejects an explicit secure: false", () => {
    expect(() =>
      createSessionStorage({
        cookie: { name: "__Host-session", secrets: [SECRET], secure: false },
      }),
    ).toThrow(/cannot be honoured/);
  });

  it("round-trips like any other name", async () => {
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "__Host-session", secrets: [SECRET] },
    });
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(session));
    expect((await sessions.getSession(cookie)).get("userId")).toBe("u_1");
  });
});

describe("__Secure- prefix", () => {
  it("forces Secure and allows a Domain", async () => {
    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "__Secure-session", secrets: [SECRET], domain: "example.com" },
    });
    const session = await sessions.getSession(new Request("http://localhost:3000/"));
    session.set("userId", "u_1");
    const setCookie = await sessions.commitSession(session);

    expect(cookieAttribute(setCookie, "Secure")).toBe(true);
    expect(cookieAttribute(setCookie, "Domain")).toBe("example.com");
  });

  it("rejects an explicit secure: false", () => {
    expect(() =>
      createSessionStorage({
        cookie: { name: "__Secure-session", secrets: [SECRET], secure: false },
      }),
    ).toThrow(/cannot be honoured/);
  });
});

describe("duplicate cookie names", () => {
  function storage() {
    return createSessionStorage<AppSession>({ cookie: { name: "session", secrets: [SECRET] } });
  }

  it("uses the real session when a junk duplicate is sent first", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const real = toCookieHeader(await sessions.commitSession(session));

    // A parent-domain cookie of the same name, planted to knock the user out.
    // Taking the first match would log them out on every request.
    const header = `session=garbage-value; ${real}`;
    expect((await sessions.getSession(header)).get("userId")).toBe("u_1");
  });

  it("uses the real session when the junk duplicate is sent last", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const real = toCookieHeader(await sessions.commitSession(session));

    expect((await sessions.getSession(`${real}; session=garbage`)).get("userId")).toBe("u_1");
  });

  it("skips a duplicate sealed with a secret this app does not know", async () => {
    const foreign = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [OTHER_SECRET] },
    });
    const foreignSession = await foreign.getSession(null);
    foreignSession.set("userId", "u_attacker");
    const foreignCookie = toCookieHeader(await foreign.commitSession(foreignSession));

    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const real = toCookieHeader(await sessions.commitSession(session));

    expect((await sessions.getSession(`${foreignCookie}; ${real}`)).get("userId")).toBe("u_1");
  });

  it("ignores cookies with other names entirely", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const real = toCookieHeader(await sessions.commitSession(session));

    const header = `theme=dark; ${real}; pracht_locale=nl`;
    expect((await sessions.getSession(header)).get("userId")).toBe("u_1");
  });

  it("caps how many duplicates one request can make it decrypt", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const real = toCookieHeader(await sessions.commitSession(session));

    // Nine junk duplicates ahead of the real one: past the candidate cap, so
    // the real cookie is never reached. That is the deliberate trade — an
    // unbounded loop turns one request into unbounded AES-GCM work.
    const stuffed = `${Array.from({ length: 9 }, (_, i) => `session=junk${i}`).join("; ")}; ${real}`;
    expect((await sessions.getSession(stuffed)).get("userId")).toBeUndefined();

    // Seven is within the cap and still finds it.
    const modest = `${Array.from({ length: 7 }, (_, i) => `session=junk${i}`).join("; ")}; ${real}`;
    expect((await sessions.getSession(modest)).get("userId")).toBe("u_1");
  });
});
