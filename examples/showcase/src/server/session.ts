/**
 * The demo's "authentication": a single cookie set by /api/auth/login. It is
 * not a security boundary and is not trying to be — it exists so the approval
 * inbox has a reviewer identity to record and so /app has something to gate on.
 */

export interface DemoUser {
  id: string;
  name: string;
  email: string;
}

const USER: DemoUser = {
  id: "user_ada",
  name: "Ada Lovelace",
  email: "ada@launchpad.example",
};

export function readSession(request: Request): DemoUser | null {
  const cookie = request.headers.get("cookie") ?? "";
  return /(?:^|;\s*)session=demo(?:;|$)/.test(cookie) ? { ...USER } : null;
}
