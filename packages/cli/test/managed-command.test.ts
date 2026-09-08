import { describe, expect, it } from "vitest";

import { startManagedCommand } from "../src/managed-command.js";

describe("managed app command", () => {
  it.skipIf(process.platform === "win32")("stops the detached process group", async () => {
    const managed = startManagedCommand(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
    );
    const pid = managed.child.pid!;
    expect(() => process.kill(pid, 0)).not.toThrow();

    managed.stop();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        return;
      }
    }
    throw new Error(`process ${pid} was still alive after stop()`);
  });
});
