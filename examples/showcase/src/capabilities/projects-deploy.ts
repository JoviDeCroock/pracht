import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";
import "../server/agent-runtime.ts";
import { deployProject } from "../server/projects-store.ts";

interface DeployInput {
  projectId: string;
  idempotencyKey?: string;
}

/**
 * `write` capabilities get no framework idempotency helper, and agents retry.
 * docs/AGENT_TRUST.md's prescription is to make the input safely repeatable, so
 * the contract carries an optional `idempotencyKey` and the store dedupes on
 * it. `deduped: true` in the output tells the caller its retry was absorbed
 * rather than doubled.
 */
export default defineCapability({
  title: "Deploy project",
  description:
    "Ship the current build of a project. Pass a stable idempotencyKey to make retries safe.",
  input: {
    type: "object",
    properties: {
      projectId: { type: "string", minLength: 1, description: "Project id from projects.search." },
      idempotencyKey: {
        type: "string",
        maxLength: 80,
        description: "Repeat the same key to retry without deploying twice.",
      },
    },
    required: ["projectId"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      deployed: { type: "boolean" },
      deduped: { type: "boolean" },
      deploys: { type: "integer" },
      status: { type: "string" },
    },
    required: ["deployed", "deduped", "deploys", "status"],
  },
  effect: "write",
  middleware: ["rateLimit"],
  expose: {
    http: true,
    webmcp: true,
    mcp: true,
  },
  async run({ input }: CapabilityRunArgs<DeployInput>) {
    const result = deployProject(input.projectId, input.idempotencyKey);
    if (!result) {
      return { deployed: false, deduped: false, deploys: 0, status: "unknown" };
    }
    return {
      deployed: !result.deduped,
      deduped: result.deduped,
      deploys: result.project.deploys,
      status: result.project.status,
    };
  },
});
