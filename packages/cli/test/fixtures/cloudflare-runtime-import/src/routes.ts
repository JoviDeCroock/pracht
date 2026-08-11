import { defineApp } from "@pracht/core";

const capabilityFile =
  process.env.PRACHT_GRAPH_FAILURE === "unknown-module"
    ? "./capabilities/unknown-runtime.ts"
    : process.env.PRACHT_GRAPH_FAILURE === "helper-call"
      ? "./capabilities/runtime-helper-call.ts"
      : process.env.PRACHT_GRAPH_FAILURE === "binding-reflection"
        ? "./capabilities/binding-reflection.ts"
        : process.env.PRACHT_GRAPH_FAILURE?.startsWith("binding-")
          ? "./capabilities/binding-use.ts"
          : process.env.PRACHT_GRAPH_FAILURE?.startsWith("constructor-")
            ? "./capabilities/runtime-construction.ts"
            : "./capabilities/edge-runtime.ts";

export const app = defineApp({
  capabilities: {
    "edge.runtime": capabilityFile,
  },
  routes: [],
});
