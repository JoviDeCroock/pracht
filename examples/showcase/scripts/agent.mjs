#!/usr/bin/env node
/**
 * A signed agent for the Launchpad showcase.
 *
 *   node scripts/agent.mjs                        # against http://localhost:5173
 *   node scripts/agent.mjs --url https://…        # against a deployment
 *   node scripts/agent.mjs --unsigned             # no signature: watch the policy bite
 *   node scripts/agent.mjs --keys                 # print the public key to pin
 *
 * It signs every request per draft-meunier-web-bot-auth-architecture-02
 * (Ed25519 over `("@authority" "signature-agent")`, tag `web-bot-auth`) using a
 * keypair derived from the seed constant below. The *public* half is pinned in
 * src/routes.ts, so the server can verify it with no network fetch.
 *
 * Deriving the key from a seed rather than committing a private key file keeps
 * this file self-contained and makes it obvious the material is demo-only.
 */

import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";

const AGENT_DOMAIN = "demo-agent.launchpad";
const SEED_PHRASE = "pracht-showcase-demo-agent-v1";

// --- key material -----------------------------------------------------------

const seed = createHash("sha256").update(SEED_PHRASE).digest();
const privateKey = createPrivateKey({
  // PKCS#8 header for an Ed25519 private key, followed by the 32-byte seed.
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
// RFC 8037 thumbprint: SHA-256 over the canonical JWK, base64url.
const keyId = createHash("sha256")
  .update(JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x }))
  .digest("base64url");

// --- argv -------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const baseUrl = value("--url", "http://localhost:5173").replace(/\/$/, "");
const signed = !flag("--unsigned");

if (flag("--keys")) {
  console.log(JSON.stringify({ x: publicJwk.x, agent: AGENT_DOMAIN, keyId }, null, 2));
  process.exit(0);
}

// --- signing ----------------------------------------------------------------

function signatureHeaders(url) {
  const authority = new URL(url).host;
  const now = Math.floor(Date.now() / 1000);
  const signatureAgent = `"https://${AGENT_DOMAIN}"`;
  const params =
    `("@authority" "signature-agent");created=${now};expires=${now + 300}` +
    `;keyid="${keyId}";alg="ed25519";tag="web-bot-auth"`;
  const base = [
    `"@authority": ${authority}`,
    `"signature-agent": ${signatureAgent}`,
    `"@signature-params": ${params}`,
  ].join("\n");

  return {
    "signature-agent": signatureAgent,
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${edSign(null, Buffer.from(base, "utf-8"), privateKey).toString("base64")}:`,
  };
}

// --- transport --------------------------------------------------------------

async function call(capability, input = {}, options = {}) {
  const path = `/api/capabilities/${capability.replaceAll(".", "/")}`;
  const url = `${baseUrl}${path}`;
  const headers = { "content-type": "application/json" };
  if (signed) Object.assign(headers, signatureHeaders(url));
  if (options.confirm) headers["x-pracht-confirm"] = options.confirm;

  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => ({ ok: false, error: { code: "invalid_json" } }));
  return { status: response.status, ms: Date.now() - started, ...body };
}

// --- output -----------------------------------------------------------------

const c = {
  dim: (s) => `[2m${s}[0m`,
  bold: (s) => `[1m${s}[0m`,
  green: (s) => `[32m${s}[0m`,
  yellow: (s) => `[33m${s}[0m`,
  red: (s) => `[31m${s}[0m`,
  cyan: (s) => `[36m${s}[0m`,
};

let step = 0;
function report(label, result) {
  step += 1;
  const code = result.ok ? "ok" : (result.error?.code ?? "error");
  const paint = result.ok ? c.green : result.status === 409 ? c.yellow : c.red;
  console.log(
    `${c.dim(String(step).padStart(2, " "))} ${c.bold(label.padEnd(34))} ` +
      `${paint(String(result.status).padEnd(4))} ${paint(code.padEnd(26))} ${c.dim(`${result.ms}ms`)}`,
  );
  const payload = result.ok ? result.data : result.error;
  if (payload) {
    console.log(c.dim(`   ${JSON.stringify(payload).slice(0, 160)}`));
  }
}

// --- the run ----------------------------------------------------------------

console.log();
console.log(c.bold(`  Launchpad agent  →  ${baseUrl}`));
console.log(
  c.dim(
    `  identity: ${signed ? `${AGENT_DOMAIN} (keyid ${keyId.slice(0, 12)}…)` : "unsigned — no Web Bot Auth headers"}`,
  ),
);
console.log();

report("agent.whoami", await call("agent.whoami"));
report("agent.brief (require policy)", await call("agent.brief"));
report("projects.search", await call("projects.search", { query: "", limit: 5 }));

const created = await call("projects.create", {
  name: `Vega ${Math.floor(Math.random() * 1000)}`,
  summary: "Created by the demo agent.",
});
report("projects.create", created);

const projectId = created.ok ? created.data.project.id : "corvus";
const idempotencyKey = `agent-${Date.now()}`;
report("projects.deploy", await call("projects.deploy", { projectId, idempotencyKey }));
report(
  "projects.deploy (same key, retry)",
  await call("projects.deploy", { projectId, idempotencyKey }),
);

console.log();
console.log(c.cyan("  Destructive flow — projects.archive"));

const archiveInput = { projectId: "corvus", reason: "Superseded by the demo agent run." };
const prepared = await call("projects.archive", archiveInput);
report("archive: prepare (no token)", prepared);

const token = prepared.error?.confirmationToken;
if (!token) {
  console.log();
  console.log(
    c.dim(
      "  No confirmation token. In human mode this means the caller had no principal to bind\n" +
        "  to — sign the requests (drop --unsigned) or sign in and use the browser flow.",
    ),
  );
  console.log();
  process.exit(0);
}

const committed = await call("projects.archive", archiveInput, { confirm: token });
report("archive: commit (token)", committed);

if (!committed.ok && committed.error?.code === "confirmation_pending") {
  console.log();
  console.log(
    `  ${c.yellow("Waiting on a human.")} Approve proposal ${c.bold(
      (committed.error.approvalId ?? "").slice(0, 16) + "…",
    )}`,
  );
  console.log(`  at ${c.cyan(`${baseUrl}/app/approvals`)} — sign in first, then press Approve.`);
  console.log();
  console.log(c.dim("  Polling every 3s for up to 2 minutes…"));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const retry = await call("projects.archive", archiveInput, { confirm: token });
    if (retry.ok || retry.error?.code !== "confirmation_pending") {
      report("archive: commit (after decision)", retry);
      break;
    }
    process.stdout.write(c.dim("."));
  }
}

console.log();
console.log(c.dim(`  Audit trail: ${baseUrl}/app/audit`));
console.log();
