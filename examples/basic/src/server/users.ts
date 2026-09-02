import { hashPassword, verifyPassword } from "@pracht/session";

/**
 * Stand-in for the app's user table. A real app looks the row up by email and
 * compares against the stored hash; the only part worth copying here is that
 * the password is never stored or compared in plaintext.
 */
export interface User {
  id: string;
  email: string;
  name: string;
}

const DEMO_USER: User = { id: "u_ada", email: "ada@example.com", name: "Ada Lovelace" };
const DEMO_PASSWORD = "lovelace";

// Hashed once, lazily: PBKDF2 is deliberately expensive, and doing it at
// module scope would pay for it on every cold start whether anyone logs in or
// not. In a real app this value comes out of the database.
let storedHash: Promise<string> | undefined;

export async function verifyCredentials(email: string, password: string): Promise<User | null> {
  storedHash ??= hashPassword(DEMO_PASSWORD);
  // The password check runs even for an unknown email so the response time
  // does not tell an attacker which addresses have accounts.
  const matches = await verifyPassword(password, await storedHash);
  return matches && email.trim().toLowerCase() === DEMO_USER.email ? DEMO_USER : null;
}
