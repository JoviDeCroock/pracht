import { realpathSync } from "node:fs";
const MAX_RESPONSE_BYTES = 1024 * 1024;

interface DiagnosticsError {
  at: number;
  path: string;
  phase: string | null;
  routeId: string | null;
  file: string | null;
  message: string;
  stack: string | null;
}

interface DiagnosticsTraffic {
  at: number;
  capability: string;
  effect: string;
  transport: string;
  via: string | null;
  outcome: string;
  status: number;
  durationMs: number;
  agent: { agentDomain: string | null; keyId: string } | null;
  tokenAuth?: { subject: string; clientId: string | null } | null;
}

interface DiagnosticsLog<T> {
  limit: number;
  recorded: number;
  events: T[];
}

interface DevDiagnostics {
  schema: "pracht-dev-diagnostics/v1";
  root: string;
  errors: DiagnosticsLog<DiagnosticsError>;
  agentTraffic: DiagnosticsLog<DiagnosticsTraffic>;
}

/** Thrown inside `parseDiagnostics` when the payload does not match. */
class InvalidDiagnostics extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidDiagnostics();
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new InvalidDiagnostics();
  return value;
}

function num(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) throw new InvalidDiagnostics();
  return value;
}

function nullableStr(value: unknown): string | null {
  return value === null ? null : str(value);
}

function log<T>(value: unknown, event: (value: unknown) => T): DiagnosticsLog<T> {
  const input = record(value);
  if (!Array.isArray(input.events)) throw new InvalidDiagnostics();
  return {
    limit: num(input.limit),
    recorded: num(input.recorded),
    events: input.events.map(event),
  };
}

/**
 * Validate the dev server's diagnostics payload, keeping only the known fields.
 * Returns `null` when it is not the supported format.
 */
function parseDiagnostics(value: unknown): DevDiagnostics | null {
  try {
    const input = record(value);
    if (input.schema !== "pracht-dev-diagnostics/v1") return null;
    return {
      schema: input.schema,
      root: str(input.root),
      errors: log(input.errors, (event) => {
        const e = record(event);
        return {
          at: num(e.at),
          path: str(e.path),
          phase: nullableStr(e.phase),
          routeId: nullableStr(e.routeId),
          file: nullableStr(e.file),
          message: str(e.message),
          stack: nullableStr(e.stack),
        };
      }),
      agentTraffic: log(input.agentTraffic, (event) => {
        const e = record(event);
        const agent = e.agent === null ? null : record(e.agent);
        const tokenAuth =
          e.tokenAuth === undefined || e.tokenAuth === null ? e.tokenAuth : record(e.tokenAuth);
        const traffic: DiagnosticsTraffic = {
          at: num(e.at),
          capability: str(e.capability),
          effect: str(e.effect),
          transport: str(e.transport),
          via: nullableStr(e.via),
          outcome: str(e.outcome),
          status: num(e.status),
          durationMs: num(e.durationMs),
          agent: agent && { agentDomain: nullableStr(agent.agentDomain), keyId: str(agent.keyId) },
        };
        if (tokenAuth !== undefined) {
          traffic.tokenAuth = tokenAuth && {
            subject: str(tokenAuth.subject),
            clientId: nullableStr(tokenAuth.clientId),
          };
        }
        return traffic;
      }),
    };
  } catch (error) {
    if (error instanceof InvalidDiagnostics) return null;
    throw error;
  }
}

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
  const data = parseDiagnostics(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!data) {
    throw new Error(
      "The URL did not return the supported Pracht dev diagnostics format. Upgrade @pracht/vite-plugin and restart pracht dev.",
    );
  }
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
