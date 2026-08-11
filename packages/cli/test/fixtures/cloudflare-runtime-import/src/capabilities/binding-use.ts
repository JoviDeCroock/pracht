import { defineCapability } from "@pracht/capabilities";
import { env } from "cloudflare:workers";

// Cloudflare itself permits top-level binding access, but Pracht's graph tools
// cannot supply authoritative bindings or make opaque placeholders fail for
// Boolean/typeof/strict-equality use. Fail at the property read instead.
void env.DB;

export default defineCapability({
  title: "Cloudflare binding read",
  description: "Exercises graph inspection's fail-closed binding access.",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  output: { type: "object", additionalProperties: false },
  expose: { http: true },
  async run() {
    return {};
  },
});
