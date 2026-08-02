import type { BaseRouteArgs } from "@pracht/core";

export async function POST({ request }: BaseRouteArgs) {
  if (new URL(request.url).searchParams.has("redirect")) {
    return Response.redirect(new URL("/", request.url), 302);
  }
  return Response.json({ saved: true });
}
