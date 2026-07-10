// Minimal capability-envelope server for the `pracht eval --start` e2e test.
// Starts listening after a short delay so the test exercises the wait loop.
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 3177);

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/capabilities/echo/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: { pong: true } }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(
    JSON.stringify({ ok: false, error: { code: "unknown_capability", message: "not found" } }),
  );
});

setTimeout(() => server.listen(port), 500);
