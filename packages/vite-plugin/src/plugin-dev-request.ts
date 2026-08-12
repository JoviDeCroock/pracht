/** Node HTTP to Web Request conversion for the Vite development server. */

import type { IncomingMessage } from "node:http";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export const DEFAULT_DEV_MAX_BODY_SIZE = 1024 * 1024; // 1 MiB

export class DevRequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "DevRequestBodyTooLargeError";
  }
}

export async function nodeToWebRequest(
  req: IncomingMessage,
  maxBodySize: number,
): Promise<Request> {
  // Dev server is always a direct connection — never trust forwarded headers.
  // Protocol is always plain HTTP (Vite's dev server does not use TLS), and
  // host comes from the standard Host header which is safe for direct clients.
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit = { method, headers };

  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalSize += buffer.byteLength;
      if (totalSize > maxBodySize) {
        throw new DevRequestBodyTooLargeError();
      }
      chunks.push(buffer);
    }
    const body = Buffer.concat(chunks);
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  return new Request(url, init);
}
