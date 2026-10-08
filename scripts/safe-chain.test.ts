import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
import { ensureBinary, parseArgs, runPackageManager } from "./safe-chain.mjs";

const directories: string[] = [];
const bytes = Buffer.from("test binary");
const checksum = createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pracht-safe-chain-"));
  directories.push(root);
  return { binary: join(root, "bin", "safe-chain"), config: join(root, "config.json") };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Safe Chain bootstrap", () => {
  it("downloads and verifies a missing binary, then reuses it without fetching", async () => {
    const { binary, config } = await fixture();
    const fetch = vi.fn().mockResolvedValue(new Response(bytes));
    vi.stubGlobal("fetch", fetch);
    await ensureBinary(binary, "linux-x64", checksum);
    expect(fetch).toHaveBeenCalledWith(
      "https://github.com/AikidoSec/safe-chain/releases/download/1.5.24/safe-chain-linux-x64",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await readFile(binary)).toEqual(bytes);
    expect(await readFile(config, "utf8")).toBe("{}\n");
    await writeFile(config, '{"minimumPackageAgeHours":72}\n');
    await ensureBinary(binary, "linux-x64", checksum);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(config, "utf8")).toBe('{"minimumPackageAgeHours":72}\n');
  });

  it("does not save a download with the wrong checksum", async () => {
    const { binary } = await fixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("tampered")));
    await expect(ensureBinary(binary, "linux-x64", checksum)).rejects.toThrow(
      "Safe Chain checksum mismatch",
    );
    await expect(readFile(binary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a tampered cached binary without downloading a replacement", async () => {
    const { binary } = await fixture();
    await mkdir(dirname(binary), { recursive: true });
    await writeFile(binary, "tampered");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(ensureBinary(binary, "linux-x64", checksum)).rejects.toThrow(
      "Safe Chain checksum mismatch",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails when the bootstrap download fails", async () => {
    const { binary } = await fixture();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    await expect(ensureBinary(binary, "linux-x64", checksum)).rejects.toThrow(
      "Safe Chain download failed: HTTP 503",
    );
    await expect(readFile(binary)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Safe Chain package-manager dispatch", () => {
  it("preserves pnpm filters and flag values", () => {
    expect(parseArgs(["--", "--filter", "@pracht/example-basic", "add", "a package"])).toEqual({
      packageManager: "pnpm",
      args: ["--filter", "@pracht/example-basic", "add", "a package"],
    });
  });

  it("selects npm for release toolchain installations", () => {
    expect(parseArgs(["--package-manager=npm", "install", "-g", "npm@11.15.0"])).toEqual({
      packageManager: "npm",
      args: ["install", "-g", "npm@11.15.0"],
    });
    expect(() => parseArgs(["--package-manager=unknown", "install"])).toThrow(
      "must be pnpm or npm",
    );
  });

  it("forwards arguments without a shell and preserves a failing exit code", async () => {
    const child = new EventEmitter();
    spawn.mockReturnValue(child);
    const result = runPackageManager("/local/safe-chain", "pnpm", [
      "--filter",
      "example",
      "add",
      "a package",
    ]);
    expect(spawn).toHaveBeenCalledWith(
      "/local/safe-chain",
      ["pnpm", "--filter", "example", "add", "a package"],
      { stdio: "inherit" },
    );
    child.emit("exit", 7, null);
    expect(await result).toBe(7);
  });

  it("preserves Ctrl-C and rejects a spawn failure", async () => {
    const child = new EventEmitter();
    spawn.mockReturnValue(child);
    const interrupted = runPackageManager("/local/safe-chain", "pnpm", ["install"]);
    child.emit("exit", null, "SIGINT");
    expect(await interrupted).toBe(130);
    const failed = runPackageManager("/local/safe-chain", "pnpm", ["install"]);
    const assertion = expect(failed).rejects.toThrow("spawn failed");
    child.emit("error", new Error("spawn failed"));
    await assertion;
  });
});
