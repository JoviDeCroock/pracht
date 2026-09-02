/**
 * Session fixation.
 *
 * The attack: plant a session cookie in the victim's browser (a sibling
 * subdomain, an XSS, plain http on a shared network), wait for them to log in,
 * then use the copy you kept. Whether it works depends entirely on what the
 * cookie *is* — a pointer to server-side state, or the state itself.
 */
import { describe, expect, it } from "vitest";

import { createMemorySessionStore, createSessionStorage, type SessionStore } from "../src/index.ts";
import { SECRET, toCookieHeader } from "./helpers.ts";

interface AppSession extends Record<string, unknown> {
  userId: string;
  cart: string;
}

function cookieStorage() {
  return createSessionStorage<AppSession>({ cookie: { name: "session", secrets: [SECRET] } });
}

function storeStorage(store: SessionStore) {
  return createSessionStorage<AppSession>({
    cookie: { name: "session", secrets: [SECRET] },
    store,
  });
}

describe("regenerate()", () => {
  it("issues a new id and keeps the data", async () => {
    const sessions = cookieStorage();
    const session = await sessions.getSession(null);
    session.set("cart", "abc");
    const before = session.id;

    await session.regenerate();

    expect(session.id).not.toBe(before);
    expect(session.id.length).toBeGreaterThan(0);
    expect(session.get("cart")).toBe("abc");
    expect(sessions.isDirty(session)).toBe(true);
  });

  it("stops an attacker-planted id from surviving login (store mode)", async () => {
    const store = createMemorySessionStore();
    const sessions = storeStorage(store);

    // 1. The attacker gets a legitimate anonymous session from the app and
    //    keeps the cookie, then plants it in the victim's browser.
    const attackerSession = await sessions.getSession(null);
    attackerSession.set("cart", "attacker-was-here");
    const plantedCookie = toCookieHeader(await sessions.commitSession(attackerSession));
    const plantedId = attackerSession.id;

    // 2. The victim arrives carrying the planted cookie and logs in. The login
    //    handler rotates the id *before* writing the user onto the session.
    const victimSession = await sessions.getSession(plantedCookie);
    expect(victimSession.id).toBe(plantedId);
    await victimSession.regenerate();
    victimSession.set("userId", "u_victim");
    await sessions.commitSession(victimSession);

    expect(victimSession.id).not.toBe(plantedId);

    // 3. The attacker replays the cookie they planted. It still unseals — it
    //    is a valid token — but the id inside it no longer names a record.
    const replayed = await sessions.getSession(plantedCookie);
    expect(replayed.get("userId")).toBeUndefined();
    expect(replayed.data).toEqual({});
    expect(await store.get(plantedId)).toBeNull();
  });

  it("would otherwise hand the attacker the victim's session", async () => {
    // The same flow without regenerate(), proving the test above is not
    // passing for some unrelated reason.
    const store = createMemorySessionStore();
    const sessions = storeStorage(store);

    const attackerSession = await sessions.getSession(null);
    attackerSession.set("cart", "attacker-was-here");
    const plantedCookie = toCookieHeader(await sessions.commitSession(attackerSession));

    const victimSession = await sessions.getSession(plantedCookie);
    victimSession.set("userId", "u_victim");
    await sessions.commitSession(victimSession);

    const replayed = await sessions.getSession(plantedCookie);
    expect(replayed.get("userId")).toBe("u_victim");
  });

  it("leaves cookie sessions unexploitable either way", async () => {
    // Cookie mode carries the sealed data, not a pointer to it, so a replayed
    // cookie decrypts to the anonymous session it was sealed with.
    const sessions = cookieStorage();

    const attackerSession = await sessions.getSession(null);
    attackerSession.set("cart", "attacker-was-here");
    const plantedCookie = toCookieHeader(await sessions.commitSession(attackerSession));

    const victimSession = await sessions.getSession(plantedCookie);
    victimSession.set("userId", "u_victim");
    await sessions.commitSession(victimSession);

    const replayed = await sessions.getSession(plantedCookie);
    expect(replayed.get("userId")).toBeUndefined();
    expect(replayed.get("cart")).toBe("attacker-was-here");
  });

  it("does not delete a store record for a session that was never stored", async () => {
    const deleted: string[] = [];
    const store: SessionStore = {
      get: () => null,
      set: () => {},
      delete: (id) => {
        deleted.push(id);
      },
    };
    const sessions = storeStorage(store);

    const fresh = await sessions.getSession(null);
    await fresh.regenerate();
    expect(deleted).toEqual([]);
  });

  it("cleans up the old record when the session was already committed", async () => {
    const store = createMemorySessionStore();
    const sessions = storeStorage(store);

    const session = await sessions.getSession(null);
    session.set("cart", "abc");
    await sessions.commitSession(session);
    const firstId = session.id;
    expect(store.size()).toBe(1);

    await session.regenerate();
    await sessions.commitSession(session);

    expect(await store.get(firstId)).toBeNull();
    expect(store.size()).toBe(1);
    expect(await store.get(session.id)).toEqual({ cart: "abc" });
  });

  it("keeps the session usable across the rotation", async () => {
    const store = createMemorySessionStore();
    const sessions = storeStorage(store);

    const session = await sessions.getSession(null);
    session.set("cart", "abc");
    await session.regenerate();
    session.set("userId", "u_1");
    const cookie = toCookieHeader(await sessions.commitSession(session));

    const next = await sessions.getSession(cookie);
    expect(next.id).toBe(session.id);
    expect(next.get("userId")).toBe("u_1");
    expect(next.get("cart")).toBe("abc");
  });
});
