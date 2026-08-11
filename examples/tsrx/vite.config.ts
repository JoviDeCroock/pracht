import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { tsrxPreact } from "@tsrx/vite-plugin-preact";

export default defineConfig(async () => {
  const { nodeAdapter } = await import("@pracht/adapter-node");

  return {
    // `tsrxPreact()` transforms the custom format. Pracht still discovers
    // `.tsrx` implicitly for compatibility; the explicit option demonstrates
    // the generic configuration recommended for new custom formats.
    plugins: [tsrxPreact(), pracht({ adapter: nodeAdapter(), additionalExtensions: [".tsrx"] })],
  };
});
