import type { BaseRouteArgs } from "previte";

export async function POST({ request }: BaseRouteArgs) {
  const body = await request.json();
  return Response.json({ echo: body });
}
