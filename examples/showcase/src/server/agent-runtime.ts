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
export const approvalStore = createMemoryApprovalStore();

setCapabilityAuditHook(recordAudit);
setCapabilityApprovalStore(approvalStore);

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
 * Read it through `serverEnv`, never a bare `process.env` — the latter is
 * define-replaced during the build and silently returns `undefined` in the
 * shipped bundle.
 *
 * Known limitation on **edge** targets (this app's Vercel adapter, and
 * Cloudflare outside a request): the SSR bundle is built with
 * `ssr.target: "webworker"`, which resolves `@pracht/core/env/server` through
 * the `browser` condition — a stub that throws — and rewrites the framework's
 * own `process.env` lookup to `{}`. So on a deployed edge build the platform
 * environment is unreachable and `PRACHT_CONFIRMATION_SECRET` never arrives,
 * no matter how it is set. `pracht dev` and Node builds read it fine.
 *
 * `setCapabilityConfirmationSecret()` is the documented escape hatch for
 * "platforms without `process.env`", and it is what keeps the deployed demo's
 * archive flow working. A production app must feed it a real secret from
 * wherever that platform *can* provide one.
 */
let configuredSecret: unknown;
try {
  configuredSecret = serverEnv[CONFIRMATION_SECRET_ENV];
} catch {
  configuredSecret = undefined;
}

if (typeof configuredSecret !== "string" || configuredSecret === "") {
  console.warn(
    `[showcase] ${CONFIRMATION_SECRET_ENV} is unreachable in this runtime — falling back ` +
      "to the demo secret. Confirmation tokens are forgeable by anyone reading this repo; " +
      "that is acceptable for a public playground over in-memory data and nowhere else.",
  );
  setCapabilityConfirmationSecret("showcase-development-confirmation-secret");
}
