import { spawn, type ChildProcess } from "node:child_process";

export interface ManagedCommand {
  child: ChildProcess;
  earlyExit: () => string | null;
  output: () => string;
  stop: () => void;
}

/** Start a shell command in its own process group so every descendant is cleaned up. */
export function startManagedCommand(command: string, cwd = process.cwd()): ManagedCommand {
  let output = "";
  let exitReason: string | null = null;
  const child = spawn(command, {
    cwd,
    detached: process.platform !== "win32",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.on("exit", (code, signal) => {
    exitReason =
      `the start command exited ${signal ? `from ${signal}` : `with code ${code ?? "unknown"}`} ` +
      "before the server answered";
  });

  return {
    child,
    earlyExit: () => exitReason,
    output: () => output,
    stop: () => stopProcessTree(child),
  };
}

/** Stop the whole shell command tree, not only its package-manager parent. */
export function stopProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {}
  }
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {}
  }
  child.kill("SIGTERM");
}
