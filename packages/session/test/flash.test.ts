/**
 * Flash values: written on one request, readable exactly once, gone after
 * that. The pattern is "saved!" surviving a POST → redirect → GET, so the
 * behaviour that matters is what the *next* request sees.
 */
import { describe, expect, it } from "vitest";

import { createSessionStorage } from "../src/index.ts";
import { SECRET, toCookieHeader } from "./helpers.ts";

interface AppSession extends Record<string, unknown> {
  userId: string;
  notice: string;
}

function storage() {
  return createSessionStorage<AppSession>({ cookie: { name: "session", secrets: [SECRET] } });
}

describe("flash", () => {
  it("survives one request and is gone on the next", async () => {
    const sessions = storage();

    // Request A — the POST handler flashes a notice and redirects.
    const a = await sessions.getSession(null);
    a.set("userId", "u_1");
    a.flash("notice", "Profile saved");
    const afterA = toCookieHeader(await sessions.commitSession(a));

    // Request B — the redirected GET reads it once.
    const b = await sessions.getSession(afterA);
    expect(b.get("notice")).toBe("Profile saved");
    const afterB = toCookieHeader(await sessions.commitSession(b));

    // Request C — it is gone, and the durable value is untouched.
    const c = await sessions.getSession(afterB);
    expect(c.get("notice")).toBeUndefined();
    expect(c.get("userId")).toBe("u_1");
  });

  it("is consumed by the read, so a second read in the same request is empty", async () => {
    const sessions = storage();
    const session = await sessions.getSession(null);
    session.flash("notice", "once");

    expect(session.get("notice")).toBe("once");
    expect(session.get("notice")).toBeUndefined();
    expect(session.has("notice")).toBe(false);
  });

  it("is visible through `data` without being consumed", async () => {
    const sessions = storage();
    const a = await sessions.getSession(null);
    a.flash("notice", "still here");
    const cookie = toCookieHeader(await sessions.commitSession(a));

    const b = await sessions.getSession(cookie);
    expect(b.data.notice).toBe("still here");
    // `data` is a snapshot, not a read: the value is still consumable.
    expect(b.get("notice")).toBe("still here");
  });

  it("marks the session dirty when consumed, so the cookie is rewritten", async () => {
    const sessions = storage();
    const a = await sessions.getSession(null);
    a.flash("notice", "once");
    const cookie = toCookieHeader(await sessions.commitSession(a));

    const b = await sessions.getSession(cookie);
    expect(sessions.isDirty(b)).toBe(false);
    b.get("notice");
    expect(sessions.isDirty(b)).toBe(true);
  });

  it("stops being single-read once it is written normally", async () => {
    const sessions = storage();
    const a = await sessions.getSession(null);
    a.flash("notice", "temporary");
    a.set("notice", "durable");
    const cookie = toCookieHeader(await sessions.commitSession(a));

    const b = await sessions.getSession(cookie);
    expect(b.get("notice")).toBe("durable");
    expect(b.get("notice")).toBe("durable");
  });

  it("is dropped by unset before it is ever read", async () => {
    const sessions = storage();
    const a = await sessions.getSession(null);
    a.flash("notice", "temporary");
    a.unset("notice");
    const cookie = toCookieHeader(await sessions.commitSession(a));

    expect((await sessions.getSession(cookie)).get("notice")).toBeUndefined();
  });
});
