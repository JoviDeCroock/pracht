import { defineCapability } from "@pracht/capabilities";
import { waitUntil } from "cloudflare:workers";

waitUntil(Promise.resolve());

export default defineCapability({
  title: "Cloudflare runtime helper call",
  description: "Exercises graph inspection's non-executable helper failure.",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  output: { type: "object", additionalProperties: false },
  expose: { http: true },
  async run() {
    return {};
  },
});
