import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStringAsync } from "preact-render-to-string";
import { renderToReadableStream } from "preact-render-to-string/stream";
import { createServer as createViteServer } from "vite";

import { createDocument } from "./fixtures/preact-v11-streaming/app.mjs";

const port = Number(process.env.PORT ?? 3104);
const fixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/preact-v11-streaming",
);
const vite = await createViteServer({
  appType: "custom",
  configFile: false,
  root: fixtureRoot,
  server: { middlewareMode: true },
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
  const routes = {
    "/stream": "stream",
    "/hydration-2": "hydration-2",
    "/head-body": "head-body",
    "/shell-head": "shell-head",
  };
  const mode = routes[url.pathname];
  if (!mode) {
    vite.middlewares(request, response, () => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });
    return;
  }

  const serverDelay = Number(url.searchParams.get("serverDelay") ?? 250);
  const config = {
    bodyDelay: Number(url.searchParams.get("bodyDelay") ?? serverDelay),
    clientDelay: Number(url.searchParams.get("clientDelay") ?? 800),
    headDelay: Number(url.searchParams.get("headDelay") ?? serverDelay),
    mode,
    serverDelay,
  };

  try {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
    });

    if (mode === "hydration-2") {
      const html = await renderToStringAsync(createDocument(config));
      response.end(`<!DOCTYPE html>${html}`);
      return;
    }

    const stream = renderToReadableStream(createDocument(config));
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
    response.end();
  } catch (error) {
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end(error instanceof Error ? error.stack : String(error));
  }
});

server.listen(port, "127.0.0.1");

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await vite.close();
  server.close(() => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void close());
}
