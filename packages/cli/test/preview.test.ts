import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectAdapterTarget, normalizeAdapterTarget } from "../src/adapter-target.ts";
import { createPreviewPlan, resolveWranglerBin } from "../src/preview.ts";

describe("detectAdapterTarget", () => {
  it("detects the cloudflare adapter from the factory call", () => {
    expect(
      detectAdapterTarget({
        rawConfig: "export default { plugins: [pracht({ adapter: cloudflareAdapter() })] };",
      }),
    ).toBe("cloudflare");
  });

  it("detects the cloudflare adapter from the package import", () => {
    expect(
      detectAdapterTarget({
        rawConfig: 'import { cloudflareAdapter as adapter } from "@pracht/adapter-cloudflare";',
      }),
    ).toBe("cloudflare");
  });

  it("detects the vercel adapter from the factory call", () => {
    expect(
      detectAdapterTarget({
        rawConfig: "export default { plugins: [pracht({ adapter: vercelAdapter() })] };",
      }),
    ).toBe("vercel");
  });

  it("detects the vercel adapter from the package import", () => {
    expect(
      detectAdapterTarget({
        rawConfig: 'import { vercelAdapter as adapter } from "@pracht/adapter-vercel";',
      }),
    ).toBe("vercel");
  });

  it("detects the netlify adapter from the factory call", () => {
    expect(
      detectAdapterTarget({
        rawConfig: "export default { plugins: [pracht({ adapter: netlifyAdapter() })] };",
      }),
    ).toBe("netlify");
  });

  it("detects the netlify adapter from the package import", () => {
    expect(
      detectAdapterTarget({
        rawConfig: 'import { netlifyAdapter as adapter } from "@pracht/adapter-netlify";',
      }),
    ).toBe("netlify");
  });

  it("detects the node adapter from the factory call", () => {
    expect(
      detectAdapterTarget({
        rawConfig:
          'import { nodeAdapter } from "@pracht/adapter-node";\nexport default { plugins: [pracht({ adapter: nodeAdapter() })] };',
      }),
    ).toBe("node");
  });

  it("defaults to node when no adapter is configured", () => {
    expect(detectAdapterTarget({ rawConfig: "export default { plugins: [pracht()] };" })).toBe(
      "node",
    );
  });
});

describe("normalizeAdapterTarget", () => {
  it("accepts the built-in adapter targets", () => {
    expect(normalizeAdapterTarget("node")).toBe("node");
    expect(normalizeAdapterTarget("cloudflare")).toBe("cloudflare");
    expect(normalizeAdapterTarget("netlify")).toBe("netlify");
    expect(normalizeAdapterTarget("vercel")).toBe("vercel");
  });

  it("returns null for custom or missing targets", () => {
    expect(normalizeAdapterTarget("my-platform")).toBe(null);
    expect(normalizeAdapterTarget(undefined)).toBe(null);
    expect(normalizeAdapterTarget(42)).toBe(null);
  });
});

describe("resolveWranglerBin", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { force: true, recursive: true });
    }
  });

  it("prefers the project-local wrangler binary", () => {
    const root = makeTempDir("pracht-preview-local-");
    const binDir = join(root, "node_modules/.bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "wrangler"), "#!/bin/sh\n", { mode: 0o755 });

    const pathDir = makeTempDir("pracht-preview-path-");
    writeFileSync(join(pathDir, "wrangler"), "#!/bin/sh\n", { mode: 0o755 });

    expect(resolveWranglerBin(root, { PATH: pathDir })).toBe(join(binDir, "wrangler"));
  });

  it("falls back to wrangler on PATH", () => {
    const root = makeTempDir("pracht-preview-root-");
    const pathDir = makeTempDir("pracht-preview-path-");
    writeFileSync(join(pathDir, "wrangler"), "#!/bin/sh\n", { mode: 0o755 });

    expect(resolveWranglerBin(root, { PATH: pathDir })).toBe(join(pathDir, "wrangler"));
  });

  it("returns null when wrangler is not installed anywhere", () => {
    const root = makeTempDir("pracht-preview-missing-");
    expect(resolveWranglerBin(root, { PATH: makeTempDir("pracht-preview-empty-") })).toBe(null);
  });
});

describe("createPreviewPlan", () => {
  const tempDirs: string[] = [];

  function makeProject(config: string): string {
    const root = mkdtempSync(join(tmpdir(), "pracht-preview-plan-"));
    tempDirs.push(root);
    writeFileSync(join(root, "vite.config.ts"), config);
    return root;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { force: true, recursive: true });
    }
  });

  it("returns platform guidance without constructing a local process", async () => {
    const root = makeProject("export default { plugins: [pracht({ adapter: vercelAdapter() })] };");

    const plan = await createPreviewPlan(root, { skipBuild: true });

    expect(plan).toMatchObject({ kind: "unsupported", target: "vercel" });
    if (plan.kind !== "unsupported") {
      throw new Error("Expected Vercel preview guidance.");
    }
    expect(plan.guidance).toContain("vercel build");
  });

  it("constructs a Node production process from an existing build", async () => {
    const root = makeProject("export default { plugins: [pracht()] };");
    const serverDir = join(root, "dist/server");
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, "server.js"), "export const buildTarget = 'node';\n");
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');

    const plan = await createPreviewPlan(root, {
      env: { EXAMPLE: "preserved", PORT: "9999" },
      port: "4312",
      skipBuild: true,
    });

    expect(plan).toMatchObject({
      kind: "process",
      args: [join(serverDir, "server.js")],
      command: process.execPath,
      cwd: root,
      env: { EXAMPLE: "preserved", PORT: "4312" },
      target: "node",
    });
  });
});
