import type { ApiRouteArgs } from "@pracht/core";

export async function GET({ context }: ApiRouteArgs) {
  const cached = await context.env.MY_KV.get("health:last-check");
  await context.env.MY_KV.put("health:last-check", new Date().toISOString());

  return Response.json({ status: "ok", lastCheck: cached });
}
