import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const hasSession = request.headers.get("cookie")?.includes("session=") ?? false;

  if (!hasSession) {
    return redirect("/", { request });
  }

  return next();
};
