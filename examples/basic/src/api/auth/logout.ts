import { redirect, type ApiRouteArgs } from "@pracht/core";

import { sessions } from "../../server/session.ts";

export async function POST({ request }: ApiRouteArgs) {
  const storage = sessions();
  const session = await storage.getSession(request);
  // `destroy` drops the record (when a store is configured) and puts an
  // immediately-expiring cookie on the response.
  return storage.destroy(session, redirect("/", { request }));
}
