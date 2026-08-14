import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  detectAdapterTarget,
  normalizeAdapterTarget,
  type AdapterTarget,
} from "./adapter-target.js";
import { runBuild } from "./build.js";
import { readProjectConfig } from "./project.js";
import { requirePositiveInteger } from "./utils.js";
import { findWranglerConfig } from "./wrangler-config.js";

const SERVER_ENTRY = "dist/server/server.js";

export interface PreviewOptions {
  env?: NodeJS.ProcessEnv;
  port?: string;
  skipBuild?: boolean;
}

export interface PreviewProcessPlan {
  kind: "process";
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  message: string;
  target: "cloudflare" | "node";
}

export interface UnsupportedPreviewPlan {
  kind: "unsupported";
  guidance: string;
  target: "netlify" | "vercel";
}

export type PreviewPlan = PreviewProcessPlan | UnsupportedPreviewPlan;

/**
 * Validate a project, build it when requested, and describe the production
 * process the CLI should launch. Process spawning and exit-code handling stay
 * at the command boundary so this policy can be tested and reused directly.
 */
export async function createPreviewPlan(
  root: string,
  options: PreviewOptions = {},
): Promise<PreviewPlan> {
  const project = readProjectConfig(root);

  if (!project.configFile) {
    throw new Error(
      "Missing vite config. `pracht preview` requires a project with pracht configured.",
    );
  }

  if (!project.hasPrachtPlugin) {
    throw new Error("vite.config does not appear to register the pracht plugin.");
  }

  const skipBuild = options.skipBuild ?? false;

  // The `buildTarget` export of an existing build is authoritative; the vite
  // config is a static fallback for projects that have not been built yet.
  let target: AdapterTarget | null = skipBuild ? await readBuildTarget(root) : null;
  target ??= detectAdapterTarget(project);

  if (target === "netlify" || target === "vercel") {
    return {
      kind: "unsupported",
      guidance: formatPlatformGuidance(target),
      target,
    };
  }

  const env = options.env ?? process.env;
  const port = requirePositiveInteger(options.port ?? env.PORT, "port", 3000);

  if (!skipBuild) {
    const { buildTarget } = await runBuild(root);
    target = normalizeAdapterTarget(buildTarget) ?? target;

    if (target === "netlify" || target === "vercel") {
      return {
        kind: "unsupported",
        guidance: formatPlatformGuidance(target),
        target,
      };
    }
  }

  const serverEntry = resolve(root, SERVER_ENTRY);
  if (!existsSync(serverEntry)) {
    throw new Error(
      `Missing ${SERVER_ENTRY}. Run \`pracht build\` first, or drop --skip-build to build automatically.`,
    );
  }

  if (target === "cloudflare") {
    const wranglerBin = resolveWranglerBin(root, env);
    if (!wranglerBin) {
      throw new Error(
        [
          "`pracht preview` needs wrangler to serve Cloudflare builds, but it was not found in node_modules or on your PATH.",
          "Install it with `npm install --save-dev wrangler` (or `pnpm add -D wrangler`) and re-run `pracht preview`.",
        ].join("\n"),
      );
    }

    if (!findWranglerConfig(root)) {
      throw new Error(
        [
          "`pracht preview` needs a wrangler config (wrangler.jsonc, wrangler.json, or wrangler.toml) pointing at the built worker.",
          'Create one with `"main": "dist/server/worker.js"` — see docs/ADAPTERS.md for a full example.',
        ].join("\n"),
      );
    }

    return {
      kind: "process",
      args: ["dev", "--port", String(port)],
      command: wranglerBin,
      cwd: root,
      env,
      message: `\n  Previewing Cloudflare build with wrangler dev on port ${port}...\n`,
      target,
    };
  }

  return {
    kind: "process",
    args: [serverEntry],
    command: process.execPath,
    cwd: root,
    env: { ...env, PORT: String(port) },
    message: `\n  Previewing production build → http://localhost:${port}\n`,
    target,
  };
}

export function resolveWranglerBin(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const binNames =
    process.platform === "win32" ? ["wrangler.cmd", "wrangler.exe", "wrangler"] : ["wrangler"];
  const searchDirs = [
    resolve(root, "node_modules/.bin"),
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
  ];

  for (const dir of searchDirs) {
    for (const name of binNames) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

async function readBuildTarget(root: string): Promise<AdapterTarget | null> {
  const serverEntry = resolve(root, SERVER_ENTRY);
  if (!existsSync(serverEntry)) return null;

  try {
    const serverMod = await import(pathToFileURL(serverEntry).href);
    return normalizeAdapterTarget(serverMod.buildTarget);
  } catch {
    return null;
  }
}

function formatPlatformGuidance(target: "netlify" | "vercel"): string {
  if (target === "netlify") {
    return [
      "",
      "  The Netlify adapter relies on Netlify Functions and CDN behavior, so `pracht preview` does not emulate it.",
      "",
      "  Use Netlify's own local runtime instead:",
      "",
      "    pracht build && netlify dev",
      "",
      "  To build and deploy with the configured Netlify project, run: netlify deploy --build --prod",
      "",
    ].join("\n");
  }

  return [
    "",
    "  The Vercel adapter has no faithful local production runtime, so `pracht preview` does not emulate it.",
    "",
    "  To exercise the Vercel build output locally, use Vercel's own tooling:",
    "",
    "    vercel build   # reproduce the production build (.vercel/output) with your project settings",
    "    vercel dev     # run a local Vercel development environment",
    "",
    "  To ship the output of `pracht build`, run: vercel deploy --prebuilt",
    "",
  ].join("\n");
}
