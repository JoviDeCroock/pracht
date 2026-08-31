import { defineConfig } from "vite";
import { nodeAdapter } from "@pracht/adapter-node";
import { pracht } from "@pracht/vite-plugin";

// PRACHT_BENCH_PREFETCH=off measures the `client.prefetch` compile-out rung.
// Every other input is identical between the two builds, so the delta is the
// prefetch runtime and nothing else.
const prefetch = process.env.PRACHT_BENCH_PREFETCH !== "off";

export default defineConfig({
  plugins: [pracht({ adapter: nodeAdapter(), client: { prefetch } })],
});
