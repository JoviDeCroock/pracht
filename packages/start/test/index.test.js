import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { getPackageManager, scaffoldProject } from "../src/index.js";

describe("create-viact", () => {
  it("detects the package manager from the npm user agent", () => {
    expect(getPackageManager("pnpm/10.0.0 npm/? node/? darwin x64")).toBe("pnpm");
    expect(getPackageManager("yarn/4.7.0 npm/? node/? darwin x64")).toBe("yarn");
    expect(getPackageManager("bun/1.2.0 npm/? node/? darwin x64")).toBe("bun");
    expect(getPackageManager("npm/10.9.0 node/v22.0.0 darwin x64")).toBe("npm");
  });

  it("scaffolds a node starter", async () => {
    const root = await mkdtemp(join(tmpdir(), "viact-start-node-"));
    const targetDir = join(root, "my-node-app");

    await scaffoldProject({
      adapter: {
        description: "Node.js server with viact preview",
        id: "node",
        label: "Node.js",
        packageName: "@viact/adapter-node",
        short: "node",
      },
      packageManager: "pnpm",
      targetDir,
    });

    const packageJson = await readFile(join(targetDir, "package.json"), "utf-8");
    const routes = await readFile(join(targetDir, "src/routes.ts"), "utf-8");

    expect(packageJson).toContain('"@viact/cli": "latest"');
    expect(packageJson).toContain('"@viact/adapter-node": "latest"');
    expect(packageJson).not.toContain("wrangler");
    expect(routes).toContain('route("/", () => import("./routes/home.tsx")');
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(false);
  });

  it("scaffolds a cloudflare starter", async () => {
    const root = await mkdtemp(join(tmpdir(), "viact-start-cf-"));
    const targetDir = join(root, "my-cf-app");

    await scaffoldProject({
      adapter: {
        description: "Cloudflare Workers with wrangler deploy",
        id: "cloudflare",
        label: "Cloudflare Workers",
        packageName: "@viact/adapter-cloudflare",
        short: "cf",
      },
      packageManager: "pnpm",
      targetDir,
    });

    const packageJson = await readFile(join(targetDir, "package.json"), "utf-8");

    expect(packageJson).toContain('"@viact/cli": "latest"');
    expect(packageJson).toContain('"@viact/adapter-cloudflare": "latest"');
    expect(packageJson).toContain('"wrangler": "^4.12.0"');
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(true);
  });
});
