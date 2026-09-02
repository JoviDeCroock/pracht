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
    ]) {
      await expect(verifyPassword("hunter2", stored)).resolves.toBe(false);
    }
  });

  it("refuses an iteration count low enough to be pointless", async () => {
    await expect(hashPassword("hunter2", { iterations: 10 })).rejects.toThrow(/at least 1000/);
  });

  it("handles non-ASCII passwords", async () => {
    const stored = await hashPassword("pässwörd–🔐", FAST);
    await expect(verifyPassword("pässwörd–🔐", stored)).resolves.toBe(true);
    await expect(verifyPassword("passwoerd-🔐", stored)).resolves.toBe(false);
  });
});
