/** Recognize Blob/File values across DOM realms without relying on `instanceof`. */
export function isBlobLike(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Blob;
  return (
    typeof candidate.size === "number" &&
    typeof candidate.type === "string" &&
    typeof candidate.slice === "function"
  );
}

export type MultipartEntry = readonly [name: string, value: string | Blob];

let multipartBoundarySequence = 0;

export function normalizeFormNewlines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "\r\n");
}

function escapeMultipartHeaderValue(value: string): string {
  return value.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
}

function createMultipartBoundary(): string {
  return `----pracht-test-${Date.now().toString(36)}-${multipartBoundarySequence++}`;
}

async function* multipartChunks(
  entries: Iterable<MultipartEntry>,
  boundary: string,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();

  for (const [name, value] of entries) {
    const disposition =
      `--${boundary}\r\nContent-Disposition: form-data; ` +
      `name="${escapeMultipartHeaderValue(name)}"`;
    if (isBlobLike(value)) {
      const filename =
        typeof (value as Blob & { name?: unknown }).name === "string"
          ? (value as Blob & { name: string }).name
          : "blob";
      const contentType = /[\r\n]/.test(value.type)
        ? "application/octet-stream"
        : value.type || "application/octet-stream";
      yield encoder.encode(
        `${disposition}; filename="${escapeMultipartHeaderValue(filename)}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      );
      yield await readBlobBytes(value);
      yield encoder.encode("\r\n");
    } else {
      yield encoder.encode(`${disposition}\r\n\r\n${value}\r\n`);
    }
  }

  yield encoder.encode(`--${boundary}--\r\n`);
}

function multipartContentType(boundary: string): string {
  return `multipart/form-data; boundary=${boundary}`;
}

/** Encode multipart entries eagerly when the caller can await Blob/File reads. */
export async function encodeMultipart(entries: Iterable<MultipartEntry>): Promise<{
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
}> {
  const boundary = createMultipartBoundary();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  for await (const part of multipartChunks(entries, boundary)) {
    parts.push(part);
    length += part.byteLength;
  }

  const body = new Uint8Array(new ArrayBuffer(length));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return { body, contentType: multipartContentType(boundary) };
}

/**
 * Stream realm-neutral multipart bytes while retaining a synchronous factory
 * API. JSDOM File values need FileReader, whose result is asynchronous.
 */
export function streamMultipart(entries: Iterable<MultipartEntry>): {
  body: ReadableStream<Uint8Array<ArrayBuffer>>;
  contentType: string;
} {
  const boundary = createMultipartBoundary();
  const iterator = multipartChunks(entries, boundary)[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (chunk.done) {
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error: unknown) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
  return { body, contentType: multipartContentType(boundary) };
}

/** Read Blob/File bytes even when JSDOM owns the value and Node owns `Request`. */
export async function readBlobBytes(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }

  if (typeof FileReader === "function") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Failed to read Blob/File body"));
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(reader.result));
          return;
        }
        reject(new TypeError("Expected FileReader to produce an ArrayBuffer"));
      };
      reader.readAsArrayBuffer(blob);
    });
  }

  throw new TypeError(
    "Cannot read this Blob/File in the current test environment. " +
      "Provide a standard Blob implementation with arrayBuffer() or FileReader support.",
  );
}
