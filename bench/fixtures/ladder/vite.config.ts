import { defineConfig } from "vite";
import { nodeAdapter } from "@pracht/adapter-node";
import { pracht } from "@pracht/vite-plugin";

// PRACHT_BENCH_PREFETCH=off and PRACHT_BENCH_GUARDS=off measure the
// `client.prefetch` and `client.navigationGuards` compile-out rungs, and
// PRACHT_BENCH_RICH_DATA=on the opt-in `client.richData` decoder, and
// PRACHT_BENCH_ISLANDS_NAVIGATION=on the opt-in `client.islandsNavigation`
// runtime in the islands bootstrap. Every other
// input is identical between the builds, so each delta is that one runtime and
// nothing else.
const prefetch = process.env.PRACHT_BENCH_PREFETCH !== "off";
const navigationGuards = process.env.PRACHT_BENCH_GUARDS !== "off";
const richData = process.env.PRACHT_BENCH_RICH_DATA === "on";
const islandsNavigation = process.env.PRACHT_BENCH_ISLANDS_NAVIGATION === "on";

export default defineConfig({
  plugins: [
    pracht({
      adapter: nodeAdapter(),
      client: { prefetch, navigationGuards, richData, islandsNavigation },
    }),
  ],
});
