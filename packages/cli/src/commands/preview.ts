import { spawn } from "node:child_process";

import { defineCommand } from "citty";

import { createPreviewPlan, type PreviewProcessPlan } from "../preview.js";

export default defineCommand({
  meta: {
    name: "preview",
    description: "Build and serve the production build locally",
  },
  args: {
    port: {
      type: "string",
      description: "Port number (defaults to $PORT or 3000)",
    },
    "skip-build": {
      type: "boolean",
      description: "Serve the existing build output without rebuilding",
    },
  },
  async run({ args }) {
    const plan = await createPreviewPlan(process.cwd(), {
      port: args.port,
      skipBuild: Boolean(args["skip-build"]),
    });

    if (plan.kind === "unsupported") {
      console.log(plan.guidance);
      process.exitCode = 1;
      return;
    }

    console.log(plan.message);
    spawnPreviewProcess(plan);
  },
});

function spawnPreviewProcess(plan: PreviewProcessPlan): void {
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "inherit",
  });

  child.on("close", (code) => {
    process.exitCode = code ?? 0;
  });

  child.on("error", (error) => {
    console.error(`Failed to start preview process: ${error.message}`);
    process.exitCode = 1;
  });
}
