import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { tsrxPreact } from "@tsrx/vite-plugin-preact";

export default defineConfig(async () => {
  const { nodeAdapter } = await import("@pracht/adapter-node");

  return {
    // `tsrxPreact()` transforms the custom format; `additionalExtensions`
    // tells Pracht to discover it as a route or shell module.
    plugins: [tsrxPreact(), pracht({ adapter: nodeAdapter(), additionalExtensions: [".tsrx"] })],
  };
});
