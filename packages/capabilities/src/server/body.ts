/**
 * Bounded request/response body reads.
 *
 * `request.text()` buffers whatever the peer sends. The Node adapter caps
 * bodies before they reach the runtime, but Workers, Netlify, and Vercel edge
 * functions hand the stream through unbounded, so every capability transport
 * that parses a body reads it through this helper instead.
 */

/** Largest capability HTTP or remote MCP request body: 1 MiB, the Node adapter default. */
export const MAX_CAPABILITY_BODY_BYTES = 1024 * 1024;

/**
 * The body's bytes, or `null` when it is larger than `maxBytes`. A declared
 * `Content-Length` over the cap is refused without reading; otherwise the
 * stream is counted as it arrives, so a missing or understated length cannot
 * buffer more than `maxBytes + one chunk`. Stream errors propagate.
 */
export async function readBoundedBody(
  message: Pick<Request, "body" | "headers">,
  maxBytes: number = MAX_CAPABILITY_BODY_BYTES,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = message.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) {
    await message.body?.cancel().catch(() => {});
    return null;
  }
  if (!message.body) return new Uint8Array(0);

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Decode like `Body.text()`: UTF-8, BOM stripped, invalid sequences replaced. */
export function decodeBody(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
