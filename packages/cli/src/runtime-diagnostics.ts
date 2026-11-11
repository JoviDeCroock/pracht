import { realpathSync } from "node:fs";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const nullableString = z.string().nullable();
const diagnosticsSchema = z.object({
  schema: z.literal("pracht-dev-diagnostics/v1"),
  root: z.string(),
  errors: z.object({
    limit: z.number(),
    recorded: z.number(),
    events: z.array(
      z.object({
        at: z.number(),
        path: z.string(),
        phase: nullableString,
        routeId: nullableString,
        file: nullableString,
        message: z.string(),
        stack: nullableString,
      }),
    ),
  }),
  agentTraffic: z.object({
    limit: z.number(),
    recorded: z.number(),
    events: z.array(
      z.object({
        at: z.number(),
        capability: z.string(),
        effect: z.string(),
        transport: z.string(),
        via: nullableString,
        outcome: z.string(),
        status: z.number(),
        durationMs: z.number(),
        agent: z.object({ agentDomain: nullableString, keyId: z.string() }).nullable(),
        tokenAuth: z
          .object({ subject: z.string(), clientId: nullableString })
          .nullable()
          .optional(),
      }),
    ),
  }),
});

/** A fixed local endpoint, never an arbitrary URL fetch for an MCP caller. */
export function devDiagnosticsUrl(input: string): URL {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use a loopback dev-server URL without credentials, query, or fragment, e.g. http://localhost:3000/.",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL("_pracht.json?diagnostics=1", url);
}

async function fetchLocalDiagnostics(url: URL): Promise<Response> {
  // Vite may listen on either localhost address. Try explicit loopback IPs,
  // rather than resolving a hostname or assuming that IPv4 is listening.
  const hosts = url.hostname === "localhost" ? ["127.0.0.1", "[::1]"] : [url.hostname];
  const signal = AbortSignal.timeout(3000);
  let failure: unknown;
  for (const hostname of hosts) {
    const endpoint = new URL(url);
    endpoint.hostname = hostname;
    try {
      return await fetch(endpoint, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
    } catch (error) {
      failure = error;
      if (signal.aborted) break;
    }
  }
  throw new Error(
    `Could not read local dev diagnostics. Start pracht dev and use its loopback URL: ${failure instanceof Error ? failure.message : String(failure)}`,
  );
}

export async function readRuntimeDiagnostics(options: {
  url: string;
  root: string;
  limit?: number;
}) {
  const url = devDiagnosticsUrl(options.url);
  const response = await fetchLocalDiagnostics(url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Dev diagnostics answered ${response.status}. Start pracht dev with a current @pracht/vite-plugin and use its loopback URL (including the Vite base, if configured). Adapter-owned dev servers do not provide this endpoint.`,
    );
  }
  if (!response.headers.get("content-type")?.startsWith("application/json") || !response.body) {
    await response.body?.cancel();
    throw new Error(
      "The URL did not return Pracht dev diagnostics JSON. Use the running pracht dev URL, not a production or preview server.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Dev diagnostics exceeded the 1 MiB response limit.");
    }
    chunks.push(value);
  }
  const parsed = diagnosticsSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!parsed.success) {
    throw new Error(
      "The URL did not return the supported Pracht dev diagnostics format. Upgrade @pracht/vite-plugin and restart pracht dev.",
    );
  }
  const data = parsed.data;
  if (realpathSync(data.root) !== realpathSync(options.root)) {
    throw new Error(
      "The dev server belongs to another project. Use this app's dev-server URL, or set cwd to its app root.",
    );
  }
  const limit = options.limit ?? 20;
  return {
    ...data,
    errors: { ...data.errors, events: data.errors.events.slice(0, limit) },
    agentTraffic: { ...data.agentTraffic, events: data.agentTraffic.events.slice(0, limit) },
  };
}
