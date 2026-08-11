import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  E2E_PORT_BLOCK_WIDTH,
  acquireE2EPortLease,
  acquireE2EWorkerPort,
  hashedWorkspaceE2EPortBase,
} from "../../../e2e/ports.ts";

const fixture = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/e2e-port-lease-child.mjs",
);
const testRoots: string[] = [];

interface ChildLease {
  event?: string;
  leasePath: string;
  portBase: number;
  token: string;
}

function writeOwner(leaseRoot: string, portBase: number, pid: unknown): void {
  const leasePath = resolve(leaseRoot, `block-${portBase}`);
  mkdirSync(leasePath, { recursive: true });
  writeFileSync(
    resolve(leasePath, "owner.json"),
    `${JSON.stringify({
      createdAt: "2000-01-01T00:00:00.000Z",
      pid,
      portBase,
      token: "stale-token",
      workspaceRoot: "/stale-workspace",
    })}\n`,
  );
}

interface AllocatorProcess {
  acquired: Promise<ChildLease>;
  child: ChildProcessWithoutNullStreams;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function makeTestRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "pracht-e2e-lease-test-"));
  testRoots.push(root);
  return root;
}

async function occupyPort(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ exclusive: true, port }, resolveListen);
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

function spawnAllocator(
  workspaceRoot: string,
  leaseRoot: string,
  override = "auto",
): AllocatorProcess {
  const child = spawn(process.execPath, [fixture, workspaceRoot, leaseRoot, override], {
    env: {
      PATH: process.env.PATH,
    },
    stdio: "pipe",
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );
  const acquired = new Promise<ChildLease>((resolveLease, rejectLease) => {
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline !== -1) {
        resolveLease(JSON.parse(stdout.slice(0, newline)) as ChildLease);
      }
    });
    child.once("error", rejectLease);
    child.once("exit", (code, signal) => {
      if (!stdout.includes("\n")) {
        rejectLease(
          new Error(
            `Lease allocator exited before acquisition (code ${String(code)}, signal ${String(signal)}): ${stderr}`,
          ),
        );
      }
    });
  });

  return { acquired, child, exited };
}

function findCollidingWorkspaceRoots(parent: string): [string, string] {
  const rootsByPort = new Map<number, string>();
  for (let index = 0; index < 1_000; index += 1) {
    const workspaceRoot = resolve(parent, `real-workspace-${index}`);
    mkdirSync(workspaceRoot);
    const preferredPort = hashedWorkspaceE2EPortBase(workspaceRoot);
    const existing = rootsByPort.get(preferredPort);
    if (existing) return [existing, workspaceRoot];
    rootsByPort.set(preferredPort, workspaceRoot);
  }
  throw new Error("Expected a workspace hash collision within 1,000 real paths");
}

async function finishAllocator(allocator: AllocatorProcess): Promise<void> {
  allocator.child.stdin.end();
  await expect(allocator.exited).resolves.toEqual({ code: 0, signal: null });
}

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Pracht E2E port leases", () => {
  it("skips an automatically preferred block when any candidate port is occupied", async () => {
    const root = makeTestRoot();
    const leaseRoot = resolve(root, "leases");
    let occupiedServer: Server | undefined;
    let workspaceRoot = "";
    let preferredPortBase = 0;

    for (let index = 0; index < 100 && !occupiedServer; index += 1) {
      workspaceRoot = resolve(root, `occupied-workspace-${index}`);
      mkdirSync(workspaceRoot);
      preferredPortBase = hashedWorkspaceE2EPortBase(workspaceRoot);
      try {
        // Occupy a non-base port to prove the allocator probes the full block.
        occupiedServer = await occupyPort(preferredPortBase + 4);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    expect(occupiedServer).toBeDefined();

    try {
      const lease = acquireE2EPortLease({ env: {}, leaseRoot, workspaceRoot });
      expect(lease.portBase).not.toBe(preferredPortBase);
      expect(lease.release()).toBe(true);
    } finally {
      await closeServer(occupiedServer!);
    }
  });

  it("fails descriptively when an explicit block contains an occupied port", async () => {
    const root = makeTestRoot();
    const leaseRoot = resolve(root, "leases");
    let occupiedServer: Server | undefined;
    let workspaceRoot = "";
    let portBase = 0;

    for (let index = 0; index < 100 && !occupiedServer; index += 1) {
      workspaceRoot = resolve(root, `explicit-occupied-workspace-${index}`);
      mkdirSync(workspaceRoot);
      portBase = hashedWorkspaceE2EPortBase(workspaceRoot);
      try {
        occupiedServer = await occupyPort(portBase + 4);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    expect(occupiedServer).toBeDefined();

    try {
      expect(() =>
        acquireE2EPortLease({
          env: {},
          leaseRoot,
          override: String(portBase),
          workspaceRoot,
        }),
      ).toThrow(
        `${portBase}-${portBase + E2E_PORT_BLOCK_WIDTH - 1} contains unavailable port: ${portBase + 4} (EADDRINUSE)`,
      );
      expect(existsSync(resolve(leaseRoot, `block-${portBase}`))).toBe(false);
    } finally {
      await closeServer(occupiedServer!);
    }
  });

  it("resolves a real sibling-workspace hash collision across simultaneous processes", async () => {
    const root = makeTestRoot();
    const leaseRoot = resolve(root, "leases");
    const [firstWorkspace, secondWorkspace] = findCollidingWorkspaceRoots(root);
    expect(hashedWorkspaceE2EPortBase(firstWorkspace)).toBe(
      hashedWorkspaceE2EPortBase(secondWorkspace),
    );

    const first = spawnAllocator(firstWorkspace, leaseRoot);
    const second = spawnAllocator(secondWorkspace, leaseRoot);
    const [firstLease, secondLease] = await Promise.all([first.acquired, second.acquired]);

    expect(firstLease.portBase).not.toBe(secondLease.portBase);
    expect(
      Math.abs(firstLease.portBase - secondLease.portBase) === E2E_PORT_BLOCK_WIDTH ||
        Math.abs(firstLease.portBase - secondLease.portBase) > E2E_PORT_BLOCK_WIDTH,
    ).toBe(true);

    await Promise.all([finishAllocator(first), finishAllocator(second)]);
    expect(readdirSync(leaseRoot)).toEqual([]);
  });

  it("gives simultaneous allocators in one workspace distinct blocks", async () => {
    const root = makeTestRoot();
    const workspaceRoot = resolve(root, "workspace");
    const leaseRoot = resolve(root, "leases");
    mkdirSync(workspaceRoot);

    const first = spawnAllocator(workspaceRoot, leaseRoot);
    const second = spawnAllocator(workspaceRoot, leaseRoot);
    const leases = await Promise.all([first.acquired, second.acquired]);

    expect(new Set(leases.map((lease) => lease.portBase)).size).toBe(2);
    await Promise.all([finishAllocator(first), finishAllocator(second)]);
  });

  it("fails clearly when an explicit block has a live owner", () => {
    const root = makeTestRoot();
    const workspaceRoot = resolve(root, "workspace");
    const otherWorkspaceRoot = resolve(root, "other-workspace");
    const leaseRoot = resolve(root, "leases");
    mkdirSync(workspaceRoot);
    mkdirSync(otherWorkspaceRoot);
    const explicitPort = "61200";
    const lease = acquireE2EPortLease({
      env: {},
      leaseRoot,
      override: explicitPort,
      workspaceRoot,
    });

    expect(() =>
      acquireE2EPortLease({
        env: {},
        leaseRoot,
        override: explicitPort,
        workspaceRoot: otherWorkspaceRoot,
      }),
    ).toThrow(/already leased by live PID .*PRACHT_E2E_PORT_BASE/);
    expect(lease.release()).toBe(true);
  });

  it("recovers an explicit block after its allocator is killed", async () => {
    const root = makeTestRoot();
    const workspaceRoot = resolve(root, "workspace");
    const leaseRoot = resolve(root, "leases");
    mkdirSync(workspaceRoot);
    const crashed = spawnAllocator(workspaceRoot, leaseRoot, "61300");
    await crashed.acquired;
    crashed.child.kill("SIGKILL");
    await expect(crashed.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });

    const replacement = acquireE2EPortLease({
      env: {},
      leaseRoot,
      override: "61300",
      workspaceRoot,
    });
    expect(replacement.portBase).toBe(61_300);
    expect(replacement.release()).toBe(true);
  });

  it("immediately reclaims syntactically valid owner metadata with PID 0", () => {
    const root = makeTestRoot();
    const workspaceRoot = resolve(root, "workspace");
    const leaseRoot = resolve(root, "leases");
    mkdirSync(workspaceRoot);
    writeOwner(leaseRoot, 61_320, 0);

    const replacement = acquireE2EPortLease({
      env: {},
      leaseRoot,
      override: "61320",
      workspaceRoot,
    });
    expect(replacement.portBase).toBe(61_320);
    expect(replacement.release()).toBe(true);
  });

  it("immediately reclaims syntactically valid owner metadata with a negative PID", () => {
    const root = makeTestRoot();
    const workspaceRoot = resolve(root, "workspace");
    const leaseRoot = resolve(root, "leases");
    mkdirSync(workspaceRoot);
    writeOwner(leaseRoot, 61_340, -1);

    const replacement = acquireE2EPortLease({
      env: {},
      leaseRoot,
      override: "61340",
      workspaceRoot,
    });
    expect(replacement.portBase).toBe(61_340);
    expect(replacement.release()).toBe(true);
  });

  it.each([
    ["fractional", 1.5],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("immediately reclaims %s PID owner metadata", (_, pid) => {
    const root = makeTestRoot();
    const workspaceRoot = resolve(root, "workspace");
    const leaseRoot = resolve(root, "leases");
    mkdirSync(workspaceRoot);
    writeOwner(leaseRoot, 61_360, pid);

    const replacement = acquireE2EPortLease({
      env: {},
      leaseRoot,
      override: "61360",
      workspaceRoot,
    });
    expect(replacement.portBase).toBe(61_360);
    expect(replacement.release()).toBe(true);
  });

  it("holds the lease through server teardown and releases it on process exit", async () => {
    const root = makeTestRoot();
    const workspaceRoot = resolve(root, "workspace");
    const leaseRoot = resolve(root, "leases");
    mkdirSync(workspaceRoot);

    const lifecycleChild = spawn(
      process.execPath,
      [fixture, workspaceRoot, leaseRoot, "61380", "process-exit"],
      { env: { PATH: process.env.PATH }, stdio: "pipe" },
    );
    lifecycleChild.stdout.setEncoding("utf8");
    const lines: Array<Record<string, unknown>> = [];
    let buffered = "";
    lifecycleChild.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        lines.push(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    });
    const waitForEvent = async (event: string): Promise<Record<string, unknown>> => {
      await expect
        .poll(() => lines.find((line) => line.event === event), { timeout: 5_000 })
        .toBeTruthy();
      return lines.find((line) => line.event === event)!;
    };

    const listening = await waitForEvent("listening");
    const leasePath = String(listening.leasePath);
    expect(existsSync(leasePath)).toBe(true);
    lifecycleChild.stdin.write("stop\n");
    await waitForEvent("stopped");
    expect(existsSync(leasePath)).toBe(true);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => lifecycleChild.once("exit", (code, signal) => resolveExit({ code, signal })),
    );
    lifecycleChild.stdin.write("exit\n");
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
    expect(existsSync(leasePath)).toBe(false);
  });

  it("does not let a delayed release remove a newer claim", () => {
    const root = makeTestRoot();
    const workspaceRoot = resolve(root, "workspace");
    const leaseRoot = resolve(root, "leases");
    mkdirSync(workspaceRoot);
    const first = acquireE2EPortLease({
      env: {},
      leaseRoot,
      override: "61400",
      workspaceRoot,
    });
    const displacedPath = `${first.leasePath}.displaced`;
    renameSync(first.leasePath, displacedPath);
    const replacement = acquireE2EPortLease({
      env: {},
      leaseRoot,
      override: "61400",
      workspaceRoot,
    });

    expect(first.release()).toBe(false);
    expect(replacement.release()).toBe(true);
    rmSync(displacedPath, { force: true, recursive: true });
  });

  it("claims distinct worker ports until simultaneous listeners stop", async () => {
    const root = makeTestRoot();
    const workspaceRoot = resolve(root, "workspace");
    const leaseRoot = resolve(root, "leases");
    mkdirSync(workspaceRoot);
    const suiteLease = acquireE2EPortLease({
      env: {},
      leaseRoot,
      override: "61440",
      workspaceRoot,
    });
    const workerLeases = await Promise.all(
      Array.from({ length: 4 }, () => acquireE2EWorkerPort({ lease: suiteLease })),
    );
    const servers: Server[] = [];
    let extraLease: Awaited<ReturnType<typeof acquireE2EWorkerPort>> | undefined;

    try {
      expect(new Set(workerLeases.map(({ port }) => port)).size).toBe(workerLeases.length);
      for (const { port } of workerLeases) servers.push(await occupyPort(port));

      extraLease = await acquireE2EWorkerPort({ lease: suiteLease });
      expect(workerLeases.map(({ port }) => port)).not.toContain(extraLease.port);
    } finally {
      await Promise.all(servers.map(closeServer));
      extraLease?.release();
      for (const lease of workerLeases) lease.release();
      suiteLease.release();
    }
  });
});
