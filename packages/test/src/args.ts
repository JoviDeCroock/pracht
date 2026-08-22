import type {
  ApiRouteArgs,
  LoaderArgs,
  MiddlewareArgs,
  RegisteredContext,
  ResolvedApiRoute,
  ResolvedRoute,
  RouteParams,
} from "@pracht/core";

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

/** Input shared by every args factory. */
export interface CreateArgsInput<TContext = RegisteredContext> extends TestRequestInput {
  /** Matched, base-free pathname. Defaults to the request URL pathname. */
  pathname?: string;
  /** Dynamic route params (e.g. `{ slug: "hello" }`). Default `{}`. */
  params?: RouteParams;
  /** Request context. A partial is accepted — provide what the code under test reads. */
  context?: Partial<TContext>;
  /** Override the abort signal. When omitted, `controller.signal` is used. */
  signal?: AbortSignal;
}

export interface CreateLoaderArgsInput<
  TContext = RegisteredContext,
> extends CreateArgsInput<TContext> {
  /** Override matched-route metadata; merged over sensible defaults. */
  route?: Partial<ResolvedRoute>;
}

export interface CreateMiddlewareArgsInput<
  TContext = RegisteredContext,
> extends CreateLoaderArgsInput<TContext> {}

export interface CreateApiArgsInput<
  TContext = RegisteredContext,
> extends CreateArgsInput<TContext> {
  /** Override matched API route metadata; merged over sensible defaults. */
  route?: Partial<ResolvedApiRoute>;
}

/**
 * The controller behind `args.signal`, so a test can abort mid-flight:
 * `args.controller.abort()`. When a custom `signal` is passed in, the
 * controller is still returned but no longer wired to `args.signal`.
 */
export interface TestAbortControls {
  controller: AbortController;
}

export type TestLoaderArgs<TContext = RegisteredContext> = LoaderArgs<TContext> & TestAbortControls;
export type TestMiddlewareArgs<TContext = RegisteredContext> = Omit<
  MiddlewareArgs<TContext>,
  "route"
> &
  TestAbortControls & { route: ResolvedRoute };
export type TestApiMiddlewareArgs<TContext = RegisteredContext> = Omit<
  MiddlewareArgs<TContext>,
  "route"
> &
  TestAbortControls & { route: ResolvedApiRoute };
export type TestApiArgs<TContext = RegisteredContext> = ApiRouteArgs<TContext> & TestAbortControls;

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

interface BuiltBaseArgs<TContext> {
  request: Request;
  params: RouteParams;
  context: TContext;
  signal: AbortSignal;
  url: URL;
  pathname: string;
  controller: AbortController;
}

function buildBaseArgs<TContext>(input: CreateArgsInput<TContext>): BuiltBaseArgs<TContext> {
  const request = createTestRequest(input);
  const controller = new AbortController();
  const url = new URL(request.url);
  return {
    request,
    params: input.params ?? {},
    context: (input.context ?? {}) as TContext,
    signal: input.signal ?? controller.signal,
    url,
    pathname: input.pathname ?? url.pathname,
    controller,
  };
}

function buildResolvedRoute(url: URL, overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    path: url.pathname,
    file: "test://route.tsx",
    middleware: [],
    middlewareFiles: [],
    segments: [],
    ...overrides,
  };
}

function buildResolvedApiRoute(
  url: URL,
  overrides: Partial<ResolvedApiRoute> = {},
): ResolvedApiRoute {
  return {
    path: url.pathname,
    file: "test://api-route.ts",
    segments: [],
    ...overrides,
  };
}

/**
 * Build a complete `LoaderArgs` for calling a route loader directly:
 *
 * ```ts
 * const args = createLoaderArgs({ url: "/blog/hello", params: { slug: "hello" } });
 * const data = await loader(args);
 * ```
 *
 * Every field has a sensible default; override only what the loader reads.
 * The returned object also carries `controller` — the `AbortController`
 * behind `args.signal` — for cancellation tests.
 */
export function createLoaderArgs<TContext = RegisteredContext>(
  input: CreateLoaderArgsInput<TContext> = {},
): TestLoaderArgs<TContext> {
  const base = buildBaseArgs(input);
  return {
    ...base,
    route: buildResolvedRoute(base.url, input.route),
  };
}

/**
 * Build a complete `MiddlewareArgs` — the same shape as `LoaderArgs` — for
 * calling middleware directly or through `runMiddleware()`.
 */
export function createMiddlewareArgs<TContext = RegisteredContext>(
  input: CreateMiddlewareArgsInput<TContext> = {},
): TestMiddlewareArgs<TContext> {
  return createLoaderArgs(input);
}

/**
 * Build middleware args for a chain attached through `defineApp({ api })`.
 * Unlike page middleware, the matched route has API metadata only — no
 * `middleware`, `middlewareFiles`, render mode, shell, or loader fields.
 */
export function createApiMiddlewareArgs<TContext = RegisteredContext>(
  input: CreateApiArgsInput<TContext> = {},
): TestApiMiddlewareArgs<TContext> {
  return createApiArgs(input);
}

/**
 * Build a complete `ApiRouteArgs` for calling an API route handler (plain or
 * `defineApi()`-wrapped) directly:
 *
 * ```ts
 * const response = await POST(createApiArgs({ url: "/api/items", body: { name: "x" } }));
 * ```
 */
export function createApiArgs<TContext = RegisteredContext>(
  input: CreateApiArgsInput<TContext> = {},
): TestApiArgs<TContext> {
  const base = buildBaseArgs(input);
  return {
    ...base,
    route: buildResolvedApiRoute(base.url, input.route),
  };
}
