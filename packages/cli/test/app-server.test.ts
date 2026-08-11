import { existsSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineConfig, ViteDevServer } from "vite";

const { createServerMock } = vi.hoisted(() => ({
  createServerMock: vi.fn(),
}));

vi.mock("vite", () => ({
  createServer: createServerMock,
}));

vi.mock("../src/project.js", () => ({
  readProjectConfig: (root: string) => ({
    configFile: `${root}/vite.config.ts`,
    hasPrachtPlugin: true,
    mode: "pages",
    root,
  }),
  resolveProjectPath: (root: string, file: string) => `${root}/${file}`,
}));

import { withAppServer } from "../src/app-server.ts";

describe("withAppServer", () => {
  const graphOnlyEnv = "PRACHT_GRAPH_ONLY";
  let graphOnlyValues: Array<string | undefined>;

  beforeEach(() => {
    graphOnlyValues = [];
    createServerMock.mockReset();
    createServerMock.mockImplementation(async () => {
      graphOnlyValues.push(process.env[graphOnlyEnv]);
      return {
        close: vi.fn(async () => {}),
        ssrLoadModule: vi.fn(async () => ({ buildTarget: "node" })),
      } as unknown as ViteDevServer;
    });
  });

  it("isolates concurrent graph readers from deployment runtimes and Vite caches", async () => {
    const previousGraphOnly = process.env[graphOnlyEnv];
    process.env[graphOnlyEnv] = "previous";
    try {
      await Promise.all([
        withAppServer("/project", async () => "first"),
        withAppServer("/project", async () => "second"),
      ]);
      expect(process.env[graphOnlyEnv]).toBe("previous");
    } finally {
      if (previousGraphOnly === undefined) {
        delete process.env[graphOnlyEnv];
      } else {
        process.env[graphOnlyEnv] = previousGraphOnly;
      }
    }

    const configs = createServerMock.mock.calls.map(([config]) => config as InlineConfig);
    expect(configs).toHaveLength(2);
    expect(graphOnlyValues).toEqual(["1", "1"]);
    expect(configs[0].cacheDir).not.toBe(configs[1].cacheDir);
    expect(configs.every((config) => config.cacheDir?.includes("pracht-graph-"))).toBe(true);
    expect(configs.every((config) => config.cacheDir && !existsSync(config.cacheDir))).toBe(true);
  });

  it("restores graph-only env before concurrent metadata and app module work", async () => {
    const startupReleases: Array<() => void> = [];
    const startupWaits = Array.from(
      { length: 2 },
      () => new Promise<void>((resolve) => startupReleases.push(resolve)),
    );
    const operationReleases: Array<() => void> = [];
    const operationWaits = Array.from(
      { length: 2 },
      () => new Promise<void>((resolve) => operationReleases.push(resolve)),
    );
    const moduleEnvValues: Array<string | undefined> = [];
    let operationCount = 0;

    createServerMock.mockImplementation(async () => {
      const index = createServerMock.mock.calls.length - 1;
      await startupWaits[index];
      return {
        close: vi.fn(async () => {}),
        ssrLoadModule: vi.fn(async () => {
          moduleEnvValues.push(process.env[graphOnlyEnv]);
          return { buildTarget: "node" };
        }),
      } as unknown as ViteDevServer;
    });

    const previousGraphOnly = process.env[graphOnlyEnv];
    process.env[graphOnlyEnv] = "previous";
    try {
      const first = withAppServer("/project-a", async () => {
        const index = operationCount++;
        await operationWaits[index];
        return "first";
      });
      await expect.poll(() => createServerMock).toHaveBeenCalledTimes(1);

      const second = withAppServer("/project-b", async () => {
        const index = operationCount++;
        await operationWaits[index];
        return "second";
      });
      // The second startup waits rather than overlapping the process env flag.
      expect(createServerMock).toHaveBeenCalledTimes(1);

      startupReleases[0]();
      await expect.poll(() => createServerMock).toHaveBeenCalledTimes(2);
      // The first server cannot evaluate metadata while the queued startup has
      // temporarily set the global graph-only flag.
      expect(moduleEnvValues).toEqual([]);

      startupReleases[1]();
      await expect.poll(() => operationCount).toBe(2);
      expect(moduleEnvValues).toEqual(["previous", "previous"]);

      operationReleases.forEach((release) => release());
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(process.env[graphOnlyEnv]).toBe("previous");
    } finally {
      operationReleases.forEach((release) => release());
      startupReleases.forEach((release) => release());
      if (previousGraphOnly === undefined) {
        delete process.env[graphOnlyEnv];
      } else {
        process.env[graphOnlyEnv] = previousGraphOnly;
      }
    }
  });
});
