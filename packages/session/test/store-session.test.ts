/**
 * Store-backed sessions: the cookie carries only a sealed id, the data lives
 * server-side. The properties that differ from cookie sessions are the ones
 * worth testing — the store is authoritative, logout invalidates everywhere,
 * and the 4 KB cookie ceiling stops applying to the data.
 */
import { describe, expect, it, vi } from "vitest";

import { createMemorySessionStore, createSessionStorage, type SessionStore } from "../src/index.ts";
import { SECRET, toCookieHeader } from "./helpers.ts";

interface AppSession extends Record<string, unknown> {
  userId: string;
  notes: string;
}

function storage(store: SessionStore) {
  return createSessionStorage<AppSession>({
    cookie: { name: "session", secrets: [SECRET] },
    store,
  });
}

describe("store-backed sessions", () => {
  it("keeps the data out of the cookie and round-trips it through the store", async () => {
    const store = createMemorySessionStore();
    const sessions = storage(store);

    const first = await sessions.getSession(null);
    first.set("userId", "u_1");
    first.set("notes", "long private note");
    const setCookie = await sessions.commitSession(first);

    expect(setCookie).not.toContain("long private note");
    expect(store.size()).toBe(1);

    const second = await sessions.getSession(toCookieHeader(setCookie));
    expect(second.id).toBe(first.id);
    expect(second.get("notes")).toBe("long private note");
  });

  it("carries a payload far past the 4 KB cookie ceiling", async () => {
    const sessions = storage(createMemorySessionStore());
    const session = await sessions.getSession(null);
    session.set("notes", "x".repeat(50_000));

    const setCookie = await sessions.commitSession(session);
    expect(setCookie.length).toBeLessThan(400);
    expect((await sessions.getSession(toCookieHeader(setCookie))).get("notes")).toHaveLength(
      50_000,
    );
  });

  it("treats the store as authoritative when the record is gone", async () => {
    const store = createMemorySessionStore();
    const sessions = storage(store);
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(session));

    // Server-side logout: the browser still holds a cryptographically valid
    // cookie, and it buys nothing.
    await store.delete(session.id);
    expect((await sessions.getSession(cookie)).get("userId")).toBeUndefined();
  });

  it("destroySession removes the record and expires the cookie", async () => {
    const store = createMemorySessionStore();
    const sessions = storage(store);
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    await sessions.commitSession(session);
    expect(store.size()).toBe(1);

    const setCookie = await sessions.destroySession(session);
    expect(store.size()).toBe(0);
    expect(setCookie).toContain("Max-Age=0");
    expect(session.data).toEqual({});
  });

  it("passes the absolute expiry through to the store", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const calls: Array<{ id: string; expiresAt: number }> = [];
    const store: SessionStore = {
      get: () => null,
      set: (id, _data, expiresAt) => {
        calls.push({ id, expiresAt });
      },
      delete: () => {},
    };

    const sessions = createSessionStorage<AppSession>({
      cookie: { name: "session", secrets: [SECRET], maxAge: 3600 },
      store,
    });
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    await sessions.commitSession(session);

    expect(calls).toHaveLength(1);
    expect(calls[0].expiresAt).toBe(Date.parse("2026-01-01T01:00:00Z"));
    vi.useRealTimers();
  });

  it("awaits an async store", async () => {
    const backing = new Map<string, Record<string, unknown>>();
    const store: SessionStore = {
      async get(id) {
        await Promise.resolve();
        return backing.get(id) ?? null;
      },
      async set(id, data) {
        await Promise.resolve();
        backing.set(id, data);
      },
      async delete(id) {
        await Promise.resolve();
        backing.delete(id);
      },
    };

    const sessions = storage(store);
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(session));
    expect((await sessions.getSession(cookie)).get("userId")).toBe("u_1");
  });
});

describe("createMemorySessionStore", () => {
  it("expires records on read rather than on a timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = createMemorySessionStore();
    await store.set("id", { userId: "u_1" }, Date.parse("2026-01-01T00:00:10Z"));

    expect(await store.get("id")).toEqual({ userId: "u_1" });
    vi.setSystemTime(new Date("2026-01-01T00:00:11Z"));
    expect(await store.get("id")).toBeNull();
    expect(store.size()).toBe(0);
    vi.useRealTimers();
  });

  it("hands back a copy, so mutating a session never edits the store in place", async () => {
    const store = createMemorySessionStore();
    await store.set("id", { userId: "u_1" }, Date.now() + 10_000);
    const record = (await store.get("id")) as Record<string, unknown>;
    record.userId = "u_2";
    expect(await store.get("id")).toEqual({ userId: "u_1" });
  });

  it("deleting an unknown id is not an error", async () => {
    const store = createMemorySessionStore();
    await expect(Promise.resolve(store.delete("nope"))).resolves.toBeUndefined();
  });
});
