import type { ApiRouteArgs } from "@pracht/core";
import { clearAudit } from "../../server/audit.ts";
import { resetProjects } from "../../server/projects-store.ts";

/**
 * Public demo housekeeping — this is a playground anyone can archive projects
 * in. Not a capability: resetting the demo is not part of Launchpad's domain,
 * and shipping it as an agent tool would be exactly the tool sprawl the
 * capability graph exists to avoid.
 */
export async function POST({ request }: ApiRouteArgs) {
  resetProjects();
  clearAudit();

  if ((request.headers.get("accept") ?? "").includes("text/html")) {
    const referer = request.headers.get("referer");
    const location = referer?.startsWith(new URL(request.url).origin) ? referer : "/playground";
    return new Response(null, { status: 303, headers: { location } });
  }
  return Response.json({ ok: true });
}
