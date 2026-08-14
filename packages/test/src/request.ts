import {
  isBlobLike,
  normalizeFormNewlines,
  readBlobBytes,
  streamMultipart,
  type MultipartEntry,
} from "./body.ts";

/** Base origin used when `url` is omitted or relative. */
export const TEST_ORIGIN = "http://localhost";

/**
 * Shorthand for building the `Request` an args factory hands to the code
 * under test. Pass a fully-formed `request` to take complete control; the
 * other fields are ignored when it is present.
 */
export interface TestRequestInput {
  /** A real `Request`. Wins over `url`, `method`, `headers`, and `body`. */
  request?: Request;
  /** Absolute or relative URL; relative paths resolve against `http://localhost`. Default `/`. */
  url?: string | URL;
  /** Defaults to `GET`, or `POST` when a `body` is provided. */
  method?: string;
  headers?: HeadersInit;
  /**
   * Request body. `BodyInit` values (string, `Blob`, `FormData`,
   * `URLSearchParams`, streams, buffers) preserve their wire representation;
   * Blob/File and `URLSearchParams` values are normalized across DOM realms.
   * A plain object or array is JSON-encoded with `Content-Type:
   * application/json`, matching `apiFetch()`.
   */
  body?: BodyInit | Record<string, unknown> | readonly unknown[] | null;
}

/** Build the `Request` from the shorthand fields (or return the real one). */
export function createTestRequest(input: TestRequestInput = {}): Request {
  if (input.request) {
    return input.request;
  }

  const url = new URL(input.url ?? "/", TEST_ORIGIN);
  const method = (input.method ?? (input.body != null ? "POST" : "GET")).toUpperCase();
  const headers = new Headers(input.headers);

  let body: BodyInit | null = null;
  if (input.body != null) {
    if (isBlobLike(input.body)) {
      body = blobBody(input.body);
      if (input.body.type && !headers.has("content-type")) {
        headers.set("content-type", input.body.type);
      }
    } else if (isUrlSearchParamsLike(input.body)) {
      body = input.body.toString();
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      }
    } else if (isFormDataLike(input.body)) {
      const entries: MultipartEntry[] = Array.from(input.body.entries(), ([name, value]) => [
        normalizeFormNewlines(name),
        isBlobLike(value) ? value : normalizeFormNewlines(String(value)),
      ]);
      const encoded = streamMultipart(entries);
      body = encoded.body;
      if (!headers.has("content-type")) {
        headers.set("content-type", encoded.contentType);
      }
    } else if (isBodyInit(input.body)) {
      body = input.body;
    } else {
      body = JSON.stringify(input.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const init: RequestInit & { duplex?: "half" } = { method, headers, body };
  if (body instanceof ReadableStream) {
    // Fetch requires opting into streaming uploads; without it the Request
    // constructor throws "duplex option is required when sending a body".
    init.duplex = "half";
  }
  return new Request(url, init);
}

function hasBodyBrand(body: unknown, brand: string): body is object {
  return (
    typeof body === "object" && body !== null && Object.prototype.toString.call(body) === brand
  );
}

function isFormDataLike(body: unknown): body is FormData {
  return (
    hasBodyBrand(body, "[object FormData]") && typeof (body as FormData).entries === "function"
  );
}

function isArrayBufferLike(body: unknown): body is ArrayBuffer {
  return (
    hasBodyBrand(body, "[object ArrayBuffer]") &&
    typeof (body as ArrayBuffer).byteLength === "number"
  );
}

function isBodyInit(body: unknown): body is BodyInit {
  return (
    typeof body === "string" ||
    body instanceof ReadableStream ||
    isArrayBufferLike(body) ||
    ArrayBuffer.isView(body)
  );
}

function isUrlSearchParamsLike(body: unknown): body is URLSearchParams {
  return (
    typeof body === "object" &&
    body !== null &&
    Object.prototype.toString.call(body) === "[object URLSearchParams]" &&
    typeof (body as URLSearchParams).entries === "function"
  );
}

function blobBody(blob: Blob): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(await readBlobBytes(blob));
        controller.close();
      } catch (error: unknown) {
        controller.error(error);
      }
    },
  });
}
