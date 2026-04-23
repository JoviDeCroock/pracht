import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { tsrxPreact } from "@tsrx/vite-plugin-preact";

export default defineConfig(async () => {
  const { nodeAdapter } = await import("@pracht/adapter-node");

  return {
    // `tsrxPreact()` is `enforce: "pre"`, so it compiles `.tsrx` modules before
    // the pracht pipeline sees them. Pracht's route/shell globs and server-only
    // export stripping both recognise `.tsrx` automatically.
    plugins: [tsrxPreact(), pracht({ adapter: nodeAdapter() })],
  };
});
