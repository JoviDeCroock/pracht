import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const E2E_PORT_BLOCK_START = 20_000;
export const E2E_PORT_BLOCK_WIDTH = 32;
// Keep automatic listeners below Linux's usual ephemeral source-port range
// (32768-60999). On shared CI runners, background outbound traffic can claim
// an ephemeral port after our availability probe but before Playwright binds.
export const E2E_PORT_BLOCK_COUNT = 384;
const E2E_WORKER_PORT_OFFSET = 8;
const INCOMPLETE_LEASE_GRACE_MS = 10_000;
const DEFAULT_LEASE_ROOT = resolve(tmpdir(), "pracht-e2e-port-leases-v1");

const PORT_BLOCK_PROBE_SOURCE = String.raw`
const { createServer } = require("node:net");
void (async () => {
  const ports = JSON.parse(process.argv[1]);
  const unavailable = [];
  await Promise.all(ports.map((port) => new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      unavailable.push({ code: error.code ?? "UNKNOWN", port });
      resolve();
    });
    server.listen({ exclusive: true, port }, () => server.close(resolve));
  })));
  process.stdout.write(JSON.stringify(unavailable));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

export const E2E_PORT_BASE_ENV = "PRACHT_E2E_PORT_BASE";
export const E2E_INSPECTOR_PORT_ENV = "PRACHT_E2E_INSPECTOR_PORT";
export const E2E_LEASE_PATH_ENV = "PRACHT_E2E_LEASE_PATH";
export const E2E_LEASE_TOKEN_ENV = "PRACHT_E2E_LEASE_TOKEN";

interface LeaseOwner {
  createdAt: string;
  pid: number;
  portBase: number;
  token: string;
  workspaceRoot: string;
}

type LeaseOwnerRead =
  | { kind: "incomplete" }
  | { kind: "invalid" }
  | { kind: "valid"; owner: LeaseOwner };

export interface E2EPortLease {
  leasePath: string;
  ownedByThisProcess: boolean;
  portBase: number;
  release: () => boolean;
  token: string;
}

export interface E2EWorkerPortLease {
  port: number;
  release: () => boolean;
}

interface AcquireE2EPortLeaseOptions {
  env?: NodeJS.ProcessEnv;
  leaseRoot?: string;
  override?: string;
  workspaceRoot?: string;
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  try {
    return realpathSync.native(workspaceRoot);
  } catch {
    // Hash the unresolved path so config loading still has deterministic output.
    return workspaceRoot;
  }
}

function validatePortBase(override: string): number {
  const port = Number(override);
  if (!Number.isInteger(port) || port < 1_024 || port + E2E_PORT_BLOCK_WIDTH > 65_535) {
    throw new Error(
      `${E2E_PORT_BASE_ENV} must reserve ${E2E_PORT_BLOCK_WIDTH} ports between 1024 and 65535; received ${JSON.stringify(override)}.`,
    );
  }
  return port;
}

/** Resolve the preferred block for a checkout. Acquisition may probe past it. */
export function hashedWorkspaceE2EPortBase(workspaceRoot: string = repoRoot): number {
  const digest = createHash("sha256").update(canonicalWorkspaceRoot(workspaceRoot)).digest();
  const block = digest.readUInt32BE(0) % E2E_PORT_BLOCK_COUNT;
  return E2E_PORT_BLOCK_START + block * E2E_PORT_BLOCK_WIDTH;
}

export function workspaceE2EPortBase(
  workspaceRoot: string = repoRoot,
  override: string | undefined = process.env[E2E_PORT_BASE_ENV],
): number {
  if (override !== undefined) {
    return validatePortBase(override);
  }

  return hashedWorkspaceE2EPortBase(workspaceRoot);
}

function readLeaseOwnerState(leasePath: string): LeaseOwnerRead {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolve(leasePath, "owner.json"), "utf8"));
  } catch {
    // A creator can be between mkdir and its atomic-enough small owner write.
    return { kind: "incomplete" };
  }

  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LeaseOwner).createdAt === "string" &&
    Number.isSafeInteger((value as LeaseOwner).pid) &&
    (value as LeaseOwner).pid > 0 &&
    Number.isSafeInteger((value as LeaseOwner).portBase) &&
    typeof (value as LeaseOwner).token === "string" &&
    typeof (value as LeaseOwner).workspaceRoot === "string"
  ) {
    return { kind: "valid", owner: value as LeaseOwner };
  }
  return { kind: "invalid" };
}

function readLeaseOwner(leasePath: string): LeaseOwner | undefined {
  const result = readLeaseOwnerState(leasePath);
  return result.kind === "valid" ? result.owner : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function incompleteLeaseIsYoung(leasePath: string): boolean {
  try {
    return Date.now() - statSync(leasePath).mtimeMs < INCOMPLETE_LEASE_GRACE_MS;
  } catch {
    return false;
  }
}

function leaseDirectory(leaseRoot: string, portBase: number): string {
  return resolve(leaseRoot, `block-${portBase}`);
}

function reclaimStaleLease(leasePath: string): boolean {
  const tombstone = `${leasePath}.stale-${process.pid}-${randomUUID()}`;
  try {
    // Renaming is the ownership hand-off. Never recursively delete the original
    // path, because another process may claim it immediately after this step.
    renameSync(leasePath, tombstone);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") return false;
    throw error;
  }
  rmSync(tombstone, { force: true, recursive: true });
  return true;
}

function releaseOwnedLease(leasePath: string, token: string): boolean {
  const owner = readLeaseOwner(leasePath);
  if (!owner || owner.token !== token) return false;

  const tombstone = `${leasePath}.released-${process.pid}-${randomUUID()}`;
  try {
    renameSync(leasePath, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  rmSync(tombstone, { force: true, recursive: true });
  return true;
}

function attachedLeaseFromEnvironment(env: NodeJS.ProcessEnv): E2EPortLease | undefined {
  const token = env[E2E_LEASE_TOKEN_ENV];
  const leasePath = env[E2E_LEASE_PATH_ENV];
  const rawPortBase = env[E2E_PORT_BASE_ENV];
  const present = [token, leasePath].filter((value) => value !== undefined).length;
  if (present === 0) return undefined;
  if (!token || !leasePath || !rawPortBase) {
    throw new Error(
      `Incomplete inherited Pracht E2E lease metadata; ${E2E_PORT_BASE_ENV}, ${E2E_LEASE_PATH_ENV}, and ${E2E_LEASE_TOKEN_ENV} must be propagated together.`,
    );
  }

  const portBase = validatePortBase(rawPortBase);
  const owner = readLeaseOwner(leasePath);
  if (
    !owner ||
    owner.token !== token ||
    owner.portBase !== portBase ||
    !processIsAlive(owner.pid)
  ) {
    throw new Error(
      `Inherited Pracht E2E lease metadata for port block ${portBase}-${portBase + E2E_PORT_BLOCK_WIDTH - 1} is stale or belongs to another run.`,
    );
  }

  return {
    leasePath,
    ownedByThisProcess: owner.pid === process.pid,
    portBase,
    release: () => releaseOwnedLease(leasePath, token),
    token,
  };
}

function activeLeaseError(portBase: number, owner: LeaseOwner | undefined): Error {
  const range = `${portBase}-${portBase + E2E_PORT_BLOCK_WIDTH - 1}`;
  if (owner) {
    return new Error(
      `Pracht E2E port block ${range} is already leased by live PID ${owner.pid} for ${JSON.stringify(owner.workspaceRoot)}. Choose another ${E2E_PORT_BASE_ENV} or wait for that run to finish.`,
    );
  }
  return new Error(
    `Pracht E2E port block ${range} is currently being claimed by another process. Choose another ${E2E_PORT_BASE_ENV} or try again.`,
  );
}

interface UnavailablePort {
  code: string;
  port: number;
}

/**
 * Probe a whole block in a short-lived process so this synchronous allocator
 * can reject ports already owned outside the lease protocol. The filesystem
 * lease is held while the probe runs, preventing two Pracht suites from
 * probing and selecting the same candidate concurrently.
 */
function unavailablePortsInBlock(portBase: number): UnavailablePort[] {
  const ports = Array.from({ length: E2E_PORT_BLOCK_WIDTH }, (_, offset) => portBase + offset);
  const output = execFileSync(
    process.execPath,
    ["--input-type=commonjs", "-e", PORT_BLOCK_PROBE_SOURCE, JSON.stringify(ports)],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(output) as UnavailablePort[];
}

function occupiedPortError(portBase: number, unavailable: UnavailablePort[]): Error {
  const details = unavailable
    .map(({ code, port }) => `${port} (${code})`)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  return new Error(
    `Pracht E2E port block ${portBase}-${portBase + E2E_PORT_BLOCK_WIDTH - 1} contains unavailable port${details.length === 1 ? "" : "s"}: ${details.join(", ")}. Choose another ${E2E_PORT_BASE_ENV} or stop the process using the port.`,
  );
}

/** Atomically lease a block, probing from the workspace hash when no override is set. */
export function acquireE2EPortLease(options: AcquireE2EPortLeaseOptions = {}): E2EPortLease {
  const env = options.env ?? process.env;
  const attached = attachedLeaseFromEnvironment(env);
  if (attached) return attached;

  const workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot ?? repoRoot);
  const leaseRoot = options.leaseRoot ?? DEFAULT_LEASE_ROOT;
  const override = options.override ?? env[E2E_PORT_BASE_ENV];
  const preferredPortBase = workspaceE2EPortBase(workspaceRoot, override);
  const explicit = override !== undefined;
  const preferredBlock = explicit
    ? 0
    : (preferredPortBase - E2E_PORT_BLOCK_START) / E2E_PORT_BLOCK_WIDTH;
  mkdirSync(leaseRoot, { recursive: true });

  for (let offset = 0; offset < (explicit ? 1 : E2E_PORT_BLOCK_COUNT); offset += 1) {
    const block = (preferredBlock + offset) % E2E_PORT_BLOCK_COUNT;
    const portBase = explicit
      ? preferredPortBase
      : E2E_PORT_BLOCK_START + block * E2E_PORT_BLOCK_WIDTH;
    const leasePath = leaseDirectory(leaseRoot, portBase);
    const token = randomUUID();

    while (true) {
      let directoryCreated = false;
      try {
        mkdirSync(leasePath);
        directoryCreated = true;
        const owner: LeaseOwner = {
          createdAt: new Date().toISOString(),
          pid: process.pid,
          portBase,
          token,
          workspaceRoot,
        };
        writeFileSync(resolve(leasePath, "owner.json"), `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        const unavailable = unavailablePortsInBlock(portBase);
        if (unavailable.length > 0) {
          releaseOwnedLease(leasePath, token);
          directoryCreated = false;
          if (explicit) throw occupiedPortError(portBase, unavailable);
          break;
        }
        return {
          leasePath,
          ownedByThisProcess: true,
          portBase,
          release: () => releaseOwnedLease(leasePath, token),
          token,
        };
      } catch (error) {
        if (directoryCreated) {
          // The path can be reclaimed and replaced if this process stalls
          // between mkdir and write. Only clean it when the owner token proves
          // it is still ours; pathname-only cleanup could delete the replacer.
          const owner = readLeaseOwner(leasePath);
          if (owner?.token === token) releaseOwnedLease(leasePath, token);
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        const ownerState = readLeaseOwnerState(leasePath);
        const owner = ownerState.kind === "valid" ? ownerState.owner : undefined;
        const active = owner
          ? processIsAlive(owner.pid)
          : ownerState.kind === "incomplete" && incompleteLeaseIsYoung(leasePath);
        if (active) {
          if (explicit) throw activeLeaseError(portBase, owner);
          break;
        }
        if (!reclaimStaleLease(leasePath)) continue;
      }
    }
  }

  throw new Error(
    `No Pracht E2E port block is available between ${E2E_PORT_BLOCK_START} and ${E2E_PORT_BLOCK_START + E2E_PORT_BLOCK_COUNT * E2E_PORT_BLOCK_WIDTH - 1}.`,
  );
}

interface ProcessExitTarget {
  once(event: "exit", listener: () => void): unknown;
}

/** Keep a lease until the owner process exits, after Playwright closes its web servers. */
export function registerE2EPortLeaseProcessExit(
  lease: E2EPortLease,
  target: ProcessExitTarget = process,
): boolean {
  if (!lease.ownedByThisProcess) return false;
  target.once("exit", lease.release);
  return true;
}

/** Release the exact lease propagated by Playwright config, if it still owns the path. */
export function releaseE2EPortLeaseFromEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env[E2E_LEASE_TOKEN_ENV];
  const leasePath = env[E2E_LEASE_PATH_ENV];
  if (!token || !leasePath) return false;
  return releaseOwnedLease(leasePath, token);
}

export function portsForBase(portBase: number) {
  return Object.freeze({
    basic: portBase,
    capabilities: portBase + 3,
    islands: portBase + 2,
    pagesRouter: portBase + 1,
  });
}

export function urlsForPorts(ports: ReturnType<typeof portsForBase>) {
  return Object.freeze({
    basic: `http://localhost:${ports.basic}`,
    capabilities: `http://localhost:${ports.capabilities}`,
    islands: `http://localhost:${ports.islands}`,
    pagesRouter: `http://localhost:${ports.pagesRouter}`,
  });
}

/** Resolve the suite-private copy of an example, falling back outside Playwright. */
export function e2eExampleDirectory(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const leasePath = env[E2E_LEASE_PATH_ENV];
  return leasePath ? resolve(leasePath, "examples", name) : resolve(repoRoot, "examples", name);
}

export const e2ePorts = portsForBase(workspaceE2EPortBase());
export const e2eUrls = urlsForPorts(e2ePorts);

async function portIsAvailable(port: number, host: string): Promise<boolean> {
  const server = createServer();
  const listening = await new Promise<boolean>((resolveListen) => {
    server.once("error", () => resolveListen(false));
    server.listen(port, host, () => resolveListen(true));
  });
  if (!listening) return false;

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
  return true;
}

function releaseWorkerPortClaim(claimPath: string, token: string): boolean {
  let owner: { token?: unknown };
  try {
    owner = JSON.parse(readFileSync(resolve(claimPath, "owner.json"), "utf8"));
  } catch {
    return false;
  }
  if (owner.token !== token) return false;

  const tombstone = `${claimPath}.released-${process.pid}-${randomUUID()}`;
  try {
    renameSync(claimPath, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  rmSync(tombstone, { force: true, recursive: true });
  return true;
}

interface AcquireE2EWorkerPortOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
  lease?: E2EPortLease;
}

/**
 * Claim a suite-private production-server port until its caller finishes.
 *
 * The filesystem claim closes the bind(0)-then-spawn race between Playwright
 * workers. The owning suite already excludes sibling suites from the complete
 * port block; the availability probe skips unrelated listeners on the host.
 */
export async function acquireE2EWorkerPort(
  options: AcquireE2EWorkerPortOptions = {},
): Promise<E2EWorkerPortLease> {
  const env = options.env ?? process.env;
  const suiteLease = options.lease ?? attachedLeaseFromEnvironment(env);
  if (!suiteLease) {
    throw new Error("A Pracht E2E suite lease is required before claiming a worker port.");
  }

  const host = options.host ?? "127.0.0.1";
  const claimsRoot = resolve(suiteLease.leasePath, "worker-ports");
  mkdirSync(claimsRoot, { recursive: true });

  for (let offset = E2E_WORKER_PORT_OFFSET; offset < E2E_PORT_BLOCK_WIDTH; offset += 1) {
    const port = suiteLease.portBase + offset;
    const claimPath = resolve(claimsRoot, String(port));
    const token = randomUUID();
    try {
      mkdirSync(claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }

    try {
      writeFileSync(resolve(claimPath, "owner.json"), `${JSON.stringify({ token })}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      if (!(await portIsAvailable(port, host))) {
        releaseWorkerPortClaim(claimPath, token);
        continue;
      }
      return {
        port,
        release: () => releaseWorkerPortClaim(claimPath, token),
      };
    } catch (error) {
      if (!releaseWorkerPortClaim(claimPath, token)) {
        rmSync(claimPath, { force: true, recursive: true });
      }
      throw error;
    }
  }

  throw new Error(
    `No worker port is available in Pracht E2E block ${suiteLease.portBase}-${suiteLease.portBase + E2E_PORT_BLOCK_WIDTH - 1}.`,
  );
}
