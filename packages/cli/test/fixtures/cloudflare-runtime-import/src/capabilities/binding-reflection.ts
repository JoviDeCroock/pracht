import { defineCapability } from "@pracht/capabilities";
import { env } from "cloudflare:workers";

// Binding reflection is runtime work, not contract declaration. The graph
// reader must fail loudly rather than making the Worker environment look empty.
Object.keys(env);

export default defineCapability({
  title: "Cloudflare binding reflection",
  description: "Exercises graph inspection's fail-closed binding placeholders.",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  output: { type: "object", additionalProperties: false },
  expose: { http: true },
  async run() {
    return {};
  },
});
