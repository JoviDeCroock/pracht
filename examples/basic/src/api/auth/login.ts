import { redirect, type ApiRouteArgs } from "@pracht/core";

import { sessions } from "../../server/session.ts";
import { verifyCredentials } from "../../server/users.ts";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  // The redirect target is user input. Anything that is not a plain
  // root-relative path is an open redirect waiting to happen.
  const requested = String(form.get("redirect") ?? "/dashboard");
  const target =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/dashboard";

  const user = await verifyCredentials(email, password);
  if (!user) {
    // `<Form>` acts on 3xx responses; a 401 JSON body would leave the page
    // looking like nothing happened.
    return redirect(`/login?error=1&redirect=${encodeURIComponent(target)}`, { request });
  }

  const storage = sessions();
  const session = await storage.getSession(request);
  session.set("userId", user.id);
  session.set("email", user.email);
  session.set("name", user.name);
  session.flash("notice", `Welcome back, ${user.name}.`);

  return storage.commit(session, redirect(target, { request }));
}
