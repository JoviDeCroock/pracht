import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig(async () => {
  const { nodeAdapter } = await import("@pracht/adapter-node");

  return {
    plugins: [pracht({ tsrx: true, adapter: nodeAdapter() })],
  };
});
