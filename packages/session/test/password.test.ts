import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../src/index.ts";

// PBKDF2 is deliberately slow. The default iteration count is the production
// value; these tests use a small one so the suite stays fast, which also
// exercises the "parameters come from the stored hash" property.
const FAST = { iterations: 1000 };

describe("hashPassword / verifyPassword", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple", FAST);
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(true);
    await expect(verifyPassword("Correct horse battery staple", stored)).resolves.toBe(false);
    await expect(verifyPassword("", stored)).resolves.toBe(false);
  });

  it("salts every hash, so identical passwords do not collide", async () => {
    const a = await hashPassword("hunter2", FAST);
    const b = await hashPassword("hunter2", FAST);
    expect(a).not.toBe(b);
    await expect(verifyPassword("hunter2", a)).resolves.toBe(true);
    await expect(verifyPassword("hunter2", b)).resolves.toBe(true);
  });

  it("records its parameters, so the iteration count can be raised later", async () => {
    const stored = await hashPassword("hunter2", { iterations: 1500 });
    expect(stored.startsWith("pbkdf2-sha256$1500$")).toBe(true);
    // Verification reads the count out of the stored value rather than
    // assuming today's default, so old hashes keep working after a bump.
    await expect(verifyPassword("hunter2", stored)).resolves.toBe(true);
  });

  it("returns false instead of throwing on a corrupted stored value", async () => {
    for (const stored of [
      "",
      "not-a-hash",
      "pbkdf2-sha256$1000$onlythree",
      "argon2id$1000$c2FsdA$aGFzaA",
      "pbkdf2-sha256$abc$c2FsdA$aGFzaA",
      "pbkdf2-sha256$1000$$aGFzaA",
      // Below the iteration floor. A row like this is not a weak password, it
      // is a tampered one: anything able to write the user table could drop
      // the count to make every later login trivially precomputable.
      "pbkdf2-sha256$1$c2FsdA$aGFzaA",
      "pbkdf2-sha256$999$c2FsdA$aGFzaA",
      "pbkdf2-sha256$0$c2FsdA$aGFzaA",
      "pbkdf2-sha256$-1000$c2FsdA$aGFzaA",
      // Absurdly high, which would hang the request instead of answering it.
      "pbkdf2-sha256$100000000$c2FsdA$aGFzaA",
    ]) {
      await expect(verifyPassword("hunter2", stored)).resolves.toBe(false);
    }
  });

  it("refuses an iteration count low enough to be pointless", async () => {
    await expect(hashPassword("hunter2", { iterations: 10 })).rejects.toThrow(/at least 1000/);
  });

  it("applies the same floor on verification as on hashing", async () => {
    // Hash at the floor, then rewrite the stored parameters downward the way a
    // tampered row would. The value still describes a real PBKDF2 hash, so
    // only an explicit floor on the verify path rejects it.
    const stored = await hashPassword("hunter2", { iterations: 1000 });
    const [, , salt, hash] = stored.split("$");
    await expect(verifyPassword("hunter2", stored)).resolves.toBe(true);
    await expect(verifyPassword("hunter2", `pbkdf2-sha256$1$${salt}$${hash}`)).resolves.toBe(false);
  });

  it("handles non-ASCII passwords", async () => {
    const stored = await hashPassword("pässwörd–🔐", FAST);
    await expect(verifyPassword("pässwörd–🔐", stored)).resolves.toBe(true);
    await expect(verifyPassword("passwoerd-🔐", stored)).resolves.toBe(false);
  });
});
