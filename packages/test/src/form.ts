import type { ApiRouteArgs, RegisteredContext, ResolvedApiRoute, RouteParams } from "@pracht/core";

import { createApiArgs, TEST_ORIGIN } from "./args.ts";
import { encodeMultipart, isBlobLike, normalizeFormNewlines, type MultipartEntry } from "./body.ts";

/**
 * A form field value: primitives are stringified with `String()`;
 * `Blob`/`File` values force multipart encoding. Arrays produce repeated
 * entries (multi-selects, checkbox groups), which `formDataToRecord()` on
 * the server groups back into arrays. Pass exactly the entries a browser
 * would put on the wire — e.g. a checked checkbox posts `"on"` and an
 * unchecked one is omitted entirely, not sent as `false`.
 */
export type FormFieldValue = string | number | boolean | Blob;
export type FormFields = Record<string, FormFieldValue | readonly FormFieldValue[]>;

export interface SubmitFormOptions<TContext = RegisteredContext> {
  /** Absolute or relative URL; relative paths resolve against `http://localhost`. Default `/`. */
  url?: string | URL;
  /**
   * Default `POST`. `GET`/`HEAD` forms carry no body — like a browser, the
   * fields are serialized into the URL's query string instead (replacing any
   * query already present on `url`).
   */
  method?: string;
  /**
   * Wire encoding. Defaults to `urlencoded` — what a plain `<form>` posts —
   * switching automatically to `multipart` when any field is a `Blob`/`File`.
   * Both encodings hit `defineApi()`'s `formDataToRecord()` parsing path.
   */
  encoding?: "urlencoded" | "multipart";
  headers?: HeadersInit;
  params?: RouteParams;
  context?: Partial<TContext>;
  route?: Partial<ResolvedApiRoute>;
  signal?: AbortSignal;
}

/** Build the form `Request` that {@link submitForm} sends, without calling a handler. */
export async function createFormRequest(
  fields: FormFields,
  options: SubmitFormOptions = {},
): Promise<Request> {
  const url = new URL(options.url ?? "/", TEST_ORIGIN);
  const method = (options.method ?? "POST").toUpperCase();

  const entries: MultipartEntry[] = [];
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      entries.push([
        normalizeFormNewlines(name),
        isBlobLike(entry) ? entry : normalizeFormNewlines(String(entry)),
      ]);
    }
  }

  const hasFile = entries.some(([, value]) => isBlobLike(value));

  // A GET/HEAD form submits its fields in the URL, not a body — the same
  // thing a browser does for `<form method="get">`. The Request constructor
  // would throw on a GET body anyway; encode the query string instead.
  if (method === "GET" || method === "HEAD") {
    if (hasFile) {
      throw new Error(
        `createFormRequest(): Blob/File fields cannot be submitted with a ${method} form. ` +
          'Use the default "POST" (or another body-carrying method).',
      );
    }
    const search = new URLSearchParams();
    for (const [name, value] of entries) {
      search.append(name, String(value));
    }
    url.search = search.toString();
    return new Request(url, { method, headers: options.headers });
  }

  const encoding = options.encoding ?? (hasFile ? "multipart" : "urlencoded");
  const headers = new Headers(options.headers);
  let body: BodyInit;
  if (encoding === "multipart") {
    const encoded = await encodeMultipart(entries);
    body = encoded.body;
    if (!headers.has("content-type")) {
      headers.set("content-type", encoded.contentType);
    }
  } else {
    if (hasFile) {
      throw new Error(
        'createFormRequest(): Blob/File fields cannot be sent as "urlencoded". ' +
          'Use encoding: "multipart" (or omit encoding to switch automatically).',
      );
    }
    const search = new URLSearchParams();
    for (const [name, value] of entries) {
      search.append(name, String(value));
    }
    body = search.toString();
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    }
  }

  // Serialize to realm-neutral bytes/text before handing the body to Request.
  // Vitest's JSDOM mode supplies its own FormData, File, and URLSearchParams
  // while retaining Node's Request implementation, which rejects those
  // otherwise-valid cross-realm objects.
  return new Request(url, { method, headers, body });
}

/**
 * Build a form-encoded `POST` `Request` — urlencoded or multipart, matching
 * what `<Form>`/native form submission sends — and call an API route handler
 * with it:
 *
 * ```ts
 * const response = await submitForm(POST, { name: "Alice", email: "a@example.com" }, {
 *   url: "/api/contact",
 * });
 * expect(response.status).toBe(200);
 * ```
 *
 * Works with plain handlers and `defineApi()`-wrapped handlers alike; the
 * request's `Content-Type` drives the same `FormData` parsing the server
 * applies to real submissions. With `method: "GET"` the fields are serialized
 * into the URL query string instead (browser `<form method="get">` behavior),
 * which exercises a `defineApi()` `query` schema rather than `body`.
 */
export async function submitForm<TContext = RegisteredContext>(
  handler: (args: ApiRouteArgs<TContext>) => Response | Promise<Response>,
  fields: FormFields,
  options: SubmitFormOptions<TContext> = {},
): Promise<Response> {
  const request = await createFormRequest(fields, options as SubmitFormOptions);
  const args = createApiArgs<TContext>({
    request,
    params: options.params,
    context: options.context,
    route: options.route,
    signal: options.signal,
  });
  return handler(args);
}
