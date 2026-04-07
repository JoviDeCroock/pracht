import type { MiddlewareFn } from "previte";

// ⚠️ NOT FOR PRODUCTION — This is a minimal example only.
// A real implementation should:
//   - Verify the session token with a cryptographic signature (e.g. HMAC)
//   - Check token expiry
//   - Set cookie attributes: HttpOnly, Secure, SameSite=Lax, Path=/
export const middleware: MiddlewareFn = async ({ request }) => {
  const hasSession = request.headers.get("cookie")?.includes("session=") ?? false;

  if (!hasSession) {
    return { redirect: "/" };
  }
};
