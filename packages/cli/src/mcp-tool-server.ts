import { z } from "zod";

/**
 * A tools-only Model Context Protocol server for `pracht dev-mcp`.
 *
 * The authoring server registers tools and nothing else, which is a small,
 * stable slice of the protocol: `initialize`, `ping`, `tools/list` and
 * `tools/call` over newline-delimited JSON-RPC on stdio. Implementing that
 * slice here keeps the protocol SDK — and the HTTP server stack it brings —
 * out of every app's `@pracht/cli` install.
 */

/** Protocol revisions whose tools-only stdio surface this server speaks. */
export const MCP_TOOL_SERVER_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

export interface CallToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

type JsonRpcId = string | number;

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * The message channel a server talks over. Structurally the same contract as
 * the protocol SDK's `Transport`, so the SDK's in-memory and stdio transports
 * (used by the tests) plug straight in.
 */
export interface McpMessageTransport {
  start(): Promise<void>;
  // Messages are typed loosely so the SDK's stricter JSON-RPC union fits;
  // the server validates every incoming frame itself.
  send(message: any): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
}

interface RegisteredTool {
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  handler: (input: any) => Promise<CallToolResult> | CallToolResult;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export class McpToolServer {
  readonly #info: { name: string; version: string };
  readonly #tools = new Map<string, RegisteredTool>();
  #transport: McpMessageTransport | undefined;

  constructor(info: { name: string; version: string }) {
    this.#info = info;
  }

  registerTool<Shape extends z.ZodRawShape>(
    name: string,
    config: { description: string; inputSchema: Shape },
    handler: (input: z.output<z.ZodObject<Shape>>) => Promise<CallToolResult> | CallToolResult,
  ): void {
    if (this.#tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    this.#tools.set(name, {
      description: config.description,
      input: z.object(config.inputSchema),
      handler,
    });
  }

  async connect(transport: McpMessageTransport): Promise<void> {
    this.#transport = transport;
    transport.onmessage = (message) => {
      void this.#receive(message);
    };
    transport.onclose = () => {
      if (this.#transport === transport) this.#transport = undefined;
    };
    await transport.start();
  }

  async close(): Promise<void> {
    const transport = this.#transport;
    this.#transport = undefined;
    await transport?.close();
  }

  async #receive(message: JsonRpcMessage): Promise<void> {
    // Responses and notifications (`notifications/initialized`,
    // `notifications/cancelled`) need no answer from a tools-only server.
    if (message.id === undefined || message.id === null || typeof message.method !== "string") {
      return;
    }
    const id = message.id;
    try {
      const result = await this.#dispatch(message.method, message.params);
      await this.#send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const code = error instanceof JsonRpcError ? error.code : INTERNAL_ERROR;
      const text = error instanceof Error ? error.message : String(error);
      await this.#send({ jsonrpc: "2.0", id, error: { code, message: text } });
    }
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion = (MCP_TOOL_SERVER_PROTOCOL_VERSIONS as readonly unknown[]).includes(
          requested,
        )
          ? (requested as string)
          : MCP_TOOL_SERVER_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.#info,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.#tools].map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: z.toJSONSchema(tool.input, { target: "draft-7", io: "input" }),
          })),
        };
      case "tools/call":
        return this.#callTool(params);
      default:
        throw new JsonRpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async #callTool(params: unknown): Promise<CallToolResult> {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string") {
      throw new JsonRpcError(INVALID_PARAMS, "tools/call requires a tool name");
    }
    const tool = this.#tools.get(name);
    if (!tool) return toolError(`Tool ${name} not found`);
    const parsed = tool.input.safeParse(args ?? {});
    if (!parsed.success) {
      return toolError(
        `Input validation error: Invalid arguments for tool ${name}: ${parsed.error.message}`,
      );
    }
    try {
      return await tool.handler(parsed.data);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }

  async #send(message: JsonRpcMessage): Promise<void> {
    await this.#transport?.send(message);
  }
}

class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Newline-delimited JSON-RPC over the process's stdin and stdout, the MCP
 * stdio transport. stdout carries protocol frames only.
 */
export class StdioMessageTransport implements McpMessageTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JsonRpcMessage) => void;

  readonly #stdin: NodeJS.ReadableStream;
  readonly #stdout: NodeJS.WritableStream;
  #buffer = "";
  #closed = false;

  constructor(
    stdin: NodeJS.ReadableStream = process.stdin,
    stdout: NodeJS.WritableStream = process.stdout,
  ) {
    this.#stdin = stdin;
    this.#stdout = stdout;
  }

  async start(): Promise<void> {
    this.#stdin.setEncoding?.("utf8");
    this.#stdin.on("data", this.#onData);
    this.#stdin.on("end", this.#onEnd);
    this.#stdin.on("error", this.#onError);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve) => {
      if (this.#stdout.write(frame)) resolve();
      else this.#stdout.once("drain", () => resolve());
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stdin.off("data", this.#onData);
    this.#stdin.off("end", this.#onEnd);
    this.#stdin.off("error", this.#onError);
    this.#stdin.pause?.();
    this.onclose?.();
  }

  #onData = (chunk: string | Buffer): void => {
    this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() !== "") this.#receive(line);
      newline = this.#buffer.indexOf("\n");
    }
  };

  #receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      void this.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: PARSE_ERROR, message: "Parse error" },
      });
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      void this.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: INVALID_REQUEST, message: "Invalid Request" },
      });
      return;
    }
    this.onmessage?.(message as JsonRpcMessage);
  }

  #onEnd = (): void => {
    void this.close();
  };

  #onError = (error: Error): void => {
    this.onerror?.(error);
  };
}
