import { redirect, type MiddlewareFn } from "@pracht/core";

// ⚠️ NOT FOR PRODUCTION — This is a minimal example only.
// A real implementation should:
//   - Verify the session token with a cryptographic signature (e.g. HMAC)
//   - Check token expiry
//   - Set cookie attributes: HttpOnly, Secure, SameSite=Lax, Path=/
export const middleware: MiddlewareFn = async ({ request }, next) => {
  const hasSession = request.headers.get("cookie")?.includes("session=") ?? false;

  if (!hasSession) {
    return redirect("/", { request });
  }

  return next();
};
