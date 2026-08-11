import { defineCapability } from "@pracht/capabilities";
import { EmailMessage } from "cloudflare:email";
import {
  cache,
  DurableObject,
  env,
  exports as workerExports,
  RpcStub,
  RpcTarget,
  tracing,
  waitUntil,
  withEnv,
  withEnvAndExports,
  withExports,
  WorkerEntrypoint,
  WorkflowEntrypoint,
} from "cloudflare:workers";
import { WorkflowEntrypoint as ModuleWorkflowEntrypoint } from "cloudflare:workflows";

// Current runtime exports must retain their import shape while graph commands
// initialize this contract in Vite's Node runner. Calling them still fails
// loudly because graph inspection has no Worker execution context.
class RuntimeMarker extends WorkerEntrypoint {}
class DurableMarker extends DurableObject {}
class WorkflowMarker extends WorkflowEntrypoint {}
class EmailMarker extends EmailMessage {}
class ModuleWorkflowMarker extends ModuleWorkflowEntrypoint {}

const runtimeShape = {
  cachePurge: cache.purge,
  DurableMarker,
  EmailMarker,
  env,
  rpcStub: RpcStub,
  rpcTarget: RpcTarget,
  tracingEnterSpan: tracing.enterSpan,
  waitUntil,
  withEnv,
  withEnvAndExports,
  withExports,
  workerExports,
  RuntimeMarker,
  ModuleWorkflowMarker,
  WorkflowMarker,
};

for (const [name, value] of Object.entries(runtimeShape)) {
  if (value === undefined) throw new Error(`Missing cloudflare:workers graph stub export: ${name}`);
}

export default defineCapability({
  title: "Cloudflare runtime import",
  description: "Proves graph commands can load contracts with Worker runtime imports.",
  effect: "read",
  input: { type: "object", additionalProperties: false },
  output: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
  },
  expose: { http: true },
  async run() {
    return { ok: true };
  },
});
