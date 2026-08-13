import type { ApiRouteArgs } from "@pracht/core";

export async function POST({ request }: ApiRouteArgs) {
  const body = await request.json();
  return Response.json({ echo: body });
}
