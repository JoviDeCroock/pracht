import { createServer } from "node:net";

import { acquireE2EPortLease, registerE2EPortLeaseProcessExit } from "../../../../e2e/ports.ts";

const [workspaceRoot, leaseRoot, rawOverride, mode] = process.argv.slice(2);
const lease = acquireE2EPortLease({
  env: {},
  leaseRoot,
  override: rawOverride === "auto" ? undefined : rawOverride,
  workspaceRoot,
});

if (mode === "process-exit") {
  registerE2EPortLeaseProcessExit(lease);
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  process.stdout.write(
    `${JSON.stringify({ event: "listening", leasePath: lease.leasePath, portBase: lease.portBase, token: lease.token })}\n`,
  );

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (command) => {
    if (command.trim() === "stop") {
      server.close(() => process.stdout.write(`${JSON.stringify({ event: "stopped" })}\n`));
    } else if (command.trim() === "exit") {
      process.exit(0);
    }
  });
} else {
  process.stdout.write(
    `${JSON.stringify({ leasePath: lease.leasePath, portBase: lease.portBase, token: lease.token })}\n`,
  );
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("end", resolve));
  lease.release();
}
