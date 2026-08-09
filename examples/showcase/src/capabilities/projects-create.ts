import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";
import "../server/agent-runtime.ts";
import { createProject } from "../server/projects-store.ts";

interface CreateInput {
  name: string;
  summary?: string;
  environment: "production" | "preview";
}

/**
 * A `write` capability. The dashboard submits it with `<Form capability>` —
 * including with JavaScript disabled, where the endpoint accepts the
 * form-encoded post, coerces the fields onto this input schema, and 303s back.
 * An agent POSTs the same endpoint with JSON. Same validation, same middleware,
 * same `run()`.
 */
export default defineCapability({
  title: "Create project",
  description: "Create a new Launchpad project. The project starts in the 'building' status.",
  input: {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 2,
        maxLength: 40,
        description: "Human-readable project name.",
      },
      summary: { type: "string", maxLength: 160, description: "One line about what it is." },
      environment: {
        type: "string",
        enum: ["production", "preview"],
        default: "preview",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: {
      project: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          status: { type: "string" },
          environment: { type: "string" },
          deploys: { type: "integer" },
          lastDeploy: { type: "string" },
          summary: { type: "string" },
        },
        required: ["id", "name", "status", "environment", "deploys", "lastDeploy", "summary"],
      },
    },
    required: ["project"],
  },
  effect: "write",
  middleware: ["rateLimit"],
  expose: {
    http: true,
    webmcp: true,
    mcp: true,
  },
  async run({ input }: CapabilityRunArgs<CreateInput>) {
    return {
      project: createProject({
        name: input.name,
        summary: input.summary,
        environment: input.environment,
      }),
    };
  },
});
