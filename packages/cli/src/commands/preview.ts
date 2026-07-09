import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineCommand } from "citty";

import { requirePositiveInteger } from "../utils.js";
import { readProjectConfig, type ProjectConfig } from "../project.js";
import { runBuild } from "./build.js";

const SERVER_ENTRY = "dist/server/server.js";
const WRANGLER_CONFIG_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];
const ADAPTER_TARGETS = new Set(["cloudflare", "deno", "node", "vercel"]);

export type AdapterTarget = "cloudflare" | "deno" | "node" | "vercel";

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
    const root = process.cwd();
    const project = readProjectConfig(root);

    if (!project.configFile) {
      throw new Error(
        "Missing vite config. `pracht preview` requires a project with pracht configured.",
      );
    }

    if (!project.hasPrachtPlugin) {
      throw new Error("vite.config does not appear to register the pracht plugin.");
    }

    const skipBuild = Boolean(args["skip-build"]);

    // The `buildTarget` export of an existing build is authoritative; the vite
    // config is a static fallback for projects that have not been built yet.
    let target: AdapterTarget | null = skipBuild ? await readBuildTarget(root) : null;
    target ??= detectAdapterTarget(project);

    if (target === "vercel") {
      printVercelGuidance();
      process.exitCode = 1;
      return;
    }

    const port = requirePositiveInteger(args.port ?? process.env.PORT, "port", 3000);

    if (!skipBuild) {
      const { buildTarget } = await runBuild(root);
      target = normalizeAdapterTarget(buildTarget) ?? target;

      if (target === "vercel") {
        printVercelGuidance();
        process.exitCode = 1;
        return;
      }
    }

    const serverEntry = resolve(root, SERVER_ENTRY);
    if (!existsSync(serverEntry)) {
      throw new Error(
        `Missing ${SERVER_ENTRY}. Run \`pracht build\` first, or drop --skip-build to build automatically.`,
      );
    }

    if (target === "cloudflare") {
      const wranglerBin = resolveWranglerBin(root);
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

      console.log(`\n  Previewing Cloudflare build with wrangler dev on port ${port}...\n`);
      spawnPreviewProcess(wranglerBin, ["dev", "--port", String(port)], { cwd: root });
      return;
    }

    if (target === "deno") {
      const denoBin = resolveDenoBin(root);
      if (!denoBin) {
        throw new Error(
          [
            "`pracht preview` needs deno to serve Deno builds, but it was not found on your PATH.",
            "Install Deno from https://deno.com/ and re-run `pracht preview`.",
          ].join("\n"),
        );
      }

      console.log(`\n  Previewing Deno build → http://localhost:${port}\n`);
      spawnPreviewProcess(
        denoBin,
        ["run", "--allow-net", "--allow-read=dist", "--allow-env=PORT", serverEntry],
        {
          cwd: root,
          env: { ...process.env, PORT: String(port) },
        },
      );
      return;
    }

    console.log(`\n  Previewing production build → http://localhost:${port}\n`);
    spawnPreviewProcess(process.execPath, [serverEntry], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
    });
  },
});

export function detectAdapterTarget(project: Pick<ProjectConfig, "rawConfig">): AdapterTarget {
  const source = project.rawConfig;

  if (/\bcloudflareAdapter\s*\(/.test(source) || source.includes("@pracht/adapter-cloudflare")) {
    return "cloudflare";
  }

  if (/\bvercelAdapter\s*\(/.test(source) || source.includes("@pracht/adapter-vercel")) {
    return "vercel";
  }

  if (/\bdenoAdapter\s*\(/.test(source) || source.includes("@pracht/adapter-deno")) {
    return "deno";
  }

  return "node";
}

export function normalizeAdapterTarget(value: unknown): AdapterTarget | null {
  return typeof value === "string" && ADAPTER_TARGETS.has(value) ? (value as AdapterTarget) : null;
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

export function resolveDenoBin(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const binNames = process.platform === "win32" ? ["deno.cmd", "deno.exe", "deno"] : ["deno"];
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

function findWranglerConfig(root: string): string | null {
  for (const name of WRANGLER_CONFIG_FILES) {
    const candidate = resolve(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function printVercelGuidance(): void {
  console.log(
    [
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
    ].join("\n"),
  );
}

function spawnPreviewProcess(
  command: string,
  commandArgs: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): void {
  const child = spawn(command, commandArgs, {
    cwd: options.cwd,
    env: options.env ?? process.env,
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
