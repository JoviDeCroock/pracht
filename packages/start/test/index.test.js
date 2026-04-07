import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { getPackageManager, scaffoldProject } from "../src/index.js";

describe("create-previte", () => {
  it("detects the package manager from the npm user agent", () => {
    expect(getPackageManager("pnpm/10.0.0 npm/? node/? darwin x64")).toBe("pnpm");
    expect(getPackageManager("yarn/4.7.0 npm/? node/? darwin x64")).toBe("yarn");
    expect(getPackageManager("bun/1.2.0 npm/? node/? darwin x64")).toBe("bun");
    expect(getPackageManager("npm/10.9.0 node/v22.0.0 darwin x64")).toBe("npm");
  });

  it("scaffolds a node starter", async () => {
    const root = await mkdtemp(join(tmpdir(), "previte-start-node-"));
    const targetDir = join(root, "my-node-app");

    await scaffoldProject({
      adapter: {
        description: "Node.js server with previte preview",
        id: "node",
        label: "Node.js",
        packageName: "@previte/adapter-node",
        short: "node",
      },
      packageManager: "pnpm",
      targetDir,
    });

    const packageJson = await readFile(join(targetDir, "package.json"), "utf-8");
    const routes = await readFile(join(targetDir, "src/routes.ts"), "utf-8");

    expect(packageJson).toContain('"@previte/cli": "latest"');
    expect(packageJson).toContain('"@previte/adapter-node": "latest"');
    expect(packageJson).not.toContain("wrangler");
    expect(routes).toContain('route("/", "./routes/home.tsx"');
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(false);
  });

  it("scaffolds a cloudflare starter", async () => {
    const root = await mkdtemp(join(tmpdir(), "previte-start-cf-"));
    const targetDir = join(root, "my-cf-app");

    await scaffoldProject({
      adapter: {
        description: "Cloudflare Workers with wrangler deploy",
        id: "cloudflare",
        label: "Cloudflare Workers",
        packageName: "@previte/adapter-cloudflare",
        short: "cf",
      },
      packageManager: "pnpm",
      targetDir,
    });

    const packageJson = await readFile(join(targetDir, "package.json"), "utf-8");
    const wranglerConfig = await readFile(join(targetDir, "wrangler.jsonc"), "utf-8");

    expect(packageJson).toContain('"@previte/cli": "latest"');
    expect(packageJson).toContain('"@previte/adapter-cloudflare": "latest"');
    expect(packageJson).toContain('"wrangler": "^4.81.0"');
    expect(packageJson).not.toContain('"@cloudflare/vite-plugin"');
    expect(wranglerConfig).toContain('"main": "dist/server/server.js"');
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(true);

    const envDts = await readFile(join(targetDir, "src/env.d.ts"), "utf-8");
    expect(envDts).toContain("interface Register");
    expect(envDts).toContain("env: Env");
  });

  it("scaffolds a vercel starter", async () => {
    const root = await mkdtemp(join(tmpdir(), "previte-start-vercel-"));
    const targetDir = join(root, "my-vercel-app");

    await scaffoldProject({
      adapter: {
        description: "Vercel Edge Functions with prebuilt deploy",
        id: "vercel",
        label: "Vercel",
        packageName: "@previte/adapter-vercel",
        short: "vercel",
      },
      packageManager: "pnpm",
      targetDir,
    });

    const packageJson = await readFile(join(targetDir, "package.json"), "utf-8");
    const readme = await readFile(join(targetDir, "README.md"), "utf-8");

    expect(packageJson).toContain('"@previte/adapter-vercel": "latest"');
    expect(packageJson).toContain('"vercel": "latest"');
    expect(packageJson).toContain('"deploy": "previte build && vercel deploy --prebuilt"');
    expect(readme).toContain("configured for Vercel");
    expect(readme).toContain("pnpm deploy");
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(false);
  });
});
