const encoder = new TextEncoder();

/**
 * A code unit no one-byte string can hold. V8 rejects this without scanning a
 * string it stores one byte per character, so the test is free for ASCII and
 * Latin-1 documents. A two-byte document is scanned up to the first such
 * character, which is why the test runs only where a transcoder exists.
 */
const NON_LATIN1 = /[\u0100-\uffff]/;

/** Below this many code units the two extra allocations cost more than they save. */
const MIN_TRANSCODE_LENGTH = 1024;

type DocumentTranscoder = (html: string) => Uint8Array<ArrayBuffer>;

let nodeTranscoder: DocumentTranscoder | null | undefined;

/**
 * Node's `TextEncoder` walks a two-byte string one code unit at a time, and a
 * single character outside Latin-1 (an arrow, a curly quote, an emoji) makes
 * the whole document two-byte. Copying the code units out and converting them
 * with `node:buffer`'s `transcode` produces the same bytes several times
 * faster. Only Node is measured, so only Node takes this path; `node:buffer`
 * is read through `process.getBuiltinModule` so this module still loads
 * everywhere else.
 */
function resolveNodeTranscoder(): DocumentTranscoder | null {
  const runtime = globalThis as {
    navigator?: { userAgent?: unknown };
    process?: { getBuiltinModule?: (id: string) => unknown };
  };
  const userAgent = runtime.navigator?.userAgent;
  if (typeof userAgent !== "string" || !userAgent.startsWith("Node.js/")) return null;
  try {
    const buffer = runtime.process?.getBuiltinModule?.("node:buffer") as
      | {
          Buffer?: { from(value: string, encoding: "utf16le"): Uint8Array };
          // Absent when Node is built without ICU.
          transcode?: (source: Uint8Array, from: "utf16le", to: "utf8") => Uint8Array<ArrayBuffer>;
        }
      | undefined;
    const NodeBuffer = buffer?.Buffer;
    const transcode = buffer?.transcode;
    if (typeof NodeBuffer?.from !== "function" || typeof transcode !== "function") return null;
    return (html) => {
      const bytes = transcode(NodeBuffer.from(html, "utf16le"), "utf16le", "utf8");
      // A plain view, so the body is the type `TextEncoder` would have returned.
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
  } catch {
    return null;
  }
}

/** Encode a rendered document to UTF-8: the bytes `TextEncoder` produces. */
export function encodeDocument(html: string): Uint8Array<ArrayBuffer> {
  if (html.length >= MIN_TRANSCODE_LENGTH) {
    if (nodeTranscoder === undefined) nodeTranscoder = resolveNodeTranscoder();
    if (nodeTranscoder && NON_LATIN1.test(html)) {
      try {
        return nodeTranscoder(html);
      } catch {
        // `transcode` rejects a lone surrogate; `TextEncoder` replaces it with
        // U+FFFD, which is what a string `Response` body would send.
      }
    }
  }
  return encoder.encode(html);
}
