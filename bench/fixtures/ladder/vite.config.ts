import { defineConfig } from "vite";
import { nodeAdapter } from "@pracht/adapter-node";
import { pracht } from "@pracht/vite-plugin";

// PRACHT_BENCH_PREFETCH=off and PRACHT_BENCH_GUARDS=off measure the
// `client.prefetch` and `client.navigationGuards` compile-out rungs. Every
// other input is identical between the builds, so each delta is that one
// runtime and nothing else.
const prefetch = process.env.PRACHT_BENCH_PREFETCH !== "off";
const navigationGuards = process.env.PRACHT_BENCH_GUARDS !== "off";

export default defineConfig({
  plugins: [pracht({ adapter: nodeAdapter(), client: { prefetch, navigationGuards } })],
});
