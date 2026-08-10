/**
 * One server-only module that wires the three runtime SPIs the agent trust
 * layer exposes. Import it for its side effects from anything server-only that
 * is guaranteed to load before a capability dispatches — every capability
 * module in this app does, which is the wiring docs/AGENT_TRUST.md recommends.
 *
 *   1. the audit hook          → /app/audit
 *   2. the approval store      → exactly-once commits + human approval
 *   3. the principal resolver  → binds a proposal to *this* signed-in user
 */

import {
  CONFIRMATION_SECRET_ENV,
  createMemoryApprovalStore,
  setCapabilityApprovalPrincipalResolver,
  setCapabilityApprovalStore,
  setCapabilityAuditHook,
  setCapabilityConfirmationSecret,
} from "@pracht/core/server";
import { serverEnv } from "@pracht/core/env/server";
import { recordAudit } from "./audit.ts";
import { readSession } from "./session.ts";

/**
 * `createMemoryApprovalStore()` is correct for one instance and lost on
 * restart. A real deployment needs a backend with conditional writes (D1,
 * Durable Objects, Postgres, Redis) — see the reference SQL in
 * docs/AGENT_TRUST.md#writing-a-store.
 */
export let approvalStore = createMemoryApprovalStore();

setCapabilityAuditHook(recordAudit);
setCapabilityApprovalStore(approvalStore);

/** Restore the public demo's approval lifecycle alongside its project data. */
export function resetApprovalStore(): void {
  approvalStore = createMemoryApprovalStore();
  setCapabilityApprovalStore(approvalStore);
}

/**
 * Which application identity owns a destructive proposal. Returning `null`
 * leaves the binding to Web Bot Auth, so a signed agent proposes as itself and
 * a signed-in human proposes as themselves. When neither is present the
 * confirmation flow fails closed with `confirmation_unavailable` — an anonymous
 * visitor cannot even open a proposal.
 *
 * Demo caveat: this cookie is handed out by a login button, so it is
 * caller-controlled. A real resolver must read a verified session.
 */
setCapabilityApprovalPrincipalResolver(({ request }) => {
  const user = readSession(request);
  return user ? user.id : null;
});

/**
 * Destructive capabilities fail closed without a confirmation secret.
 *
 * Read it through `serverEnv`, never a bare `process.env`: the build inlines
 * `process.env.NODE_ENV` and app code has no business depending on which reads
 * survive that. `serverEnv` resolves to `process.env` on Node and Vercel and to
 * the worker bindings on Cloudflare — where they only exist per request, hence
 * the try/catch around this module-level read.
 *
 * The fallback keeps `pracht dev` usable with no setup, and doubles as the
 * `setCapabilityConfirmationSecret()` escape hatch for platforms that hand
 * their secrets to application code some other way. It shouts, because a
 * committed secret makes confirmation tokens forgeable.
 */
let configuredSecret: unknown;
try {
  configuredSecret = serverEnv[CONFIRMATION_SECRET_ENV];
} catch {
  // Cloudflare: bindings arrive per request, so there is nothing to read yet.
  configuredSecret = undefined;
}

if (typeof configuredSecret !== "string" || configuredSecret === "") {
  console.warn(
    `[showcase] ${CONFIRMATION_SECRET_ENV} is not set — falling back to the demo secret. ` +
      "Confirmation tokens are then forgeable by anyone reading this repo: fine for a public " +
      "playground over in-memory data, and nowhere else.",
  );
  setCapabilityConfirmationSecret("showcase-development-confirmation-secret");
}
