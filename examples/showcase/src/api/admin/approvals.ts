import type { ApiRouteArgs } from "@pracht/core";
import { approvalStore } from "../../server/agent-runtime.ts";
import { readSession } from "../../server/session.ts";

/**
 * Who may approve a destructive operation is an application decision, so pracht
 * ships no approval endpoint and no approval UI — a framework-default approval
 * route would be the same mistake as trusting a host's "the user approved it".
 *
 * This is the application's answer: a reviewer inbox behind the app's own
 * session check. /app/approvals renders it.
 */

export async function GET({ request }: ApiRouteArgs) {
  const user = readSession(request);
  if (!user) {
    return Response.json({ ok: false, error: "not_authenticated" }, { status: 401 });
  }
  return Response.json({ ok: true, pending: await approvalStore.listPending() });
}

export async function POST({ request }: ApiRouteArgs) {
  const user = readSession(request);
  if (!user) {
    return Response.json({ ok: false, error: "not_authenticated" }, { status: 401 });
  }

  const form = await readBody(request);
  const id = typeof form.id === "string" ? form.id : "";
  const decision =
    form.decision === "approved" || form.decision === "rejected" ? form.decision : null;

  if (!id || !decision) {
    return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }

  const decided = await approvalStore.decide(id, decision, user.email);

  // The inbox posts as a plain form so it works without JavaScript; send the
  // browser back to the page it came from.
  if ((request.headers.get("accept") ?? "").includes("text/html")) {
    return new Response(null, { status: 303, headers: { location: "/app/approvals" } });
  }
  return Response.json({ ok: decided });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as Record<string, unknown>;
  }
  const form = await request.formData();
  return Object.fromEntries(form.entries());
}
