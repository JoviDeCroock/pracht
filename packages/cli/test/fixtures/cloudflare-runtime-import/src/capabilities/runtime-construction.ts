import { defineCapability } from "@pracht/capabilities";
import { EmailMessage } from "cloudflare:email";
import { RpcTarget } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workflows";

// Importing and subclassing runtime classes is declaration work and remains
// safe. Constructing them requires a real Worker runtime and must fail closed
// when graph readers evaluate this contract in Node.
switch (process.env.PRACHT_GRAPH_FAILURE) {
  case "constructor-rpc-target":
    new RpcTarget();
    break;
  case "constructor-email-message":
    new EmailMessage();
    break;
  case "constructor-workflow-entrypoint":
    new WorkflowEntrypoint();
    break;
}

export default defineCapability({
  title: "Cloudflare runtime construction",
  description: "Exercises graph inspection's fail-closed runtime class stubs.",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  output: { type: "object", additionalProperties: false },
  expose: { http: true },
  async run() {
    return {};
  },
});
