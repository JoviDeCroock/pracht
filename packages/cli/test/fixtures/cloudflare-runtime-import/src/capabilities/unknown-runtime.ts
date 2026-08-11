import { defineCapability } from "@pracht/capabilities";
import { runtimeMarker } from "cloudflare:future-runtime";

void runtimeMarker;

export default defineCapability({
  title: "Unknown Cloudflare runtime module",
  description: "Exercises graph inspection's unsupported-module failure.",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  output: { type: "object", additionalProperties: false },
  expose: { http: true },
  async run() {
    return {};
  },
});
