import type { ApiRouteArgs, RegisteredContext, ResolvedApiRoute, RouteParams } from "@pracht/core";

import { createApiArgs, TEST_ORIGIN } from "./args.ts";

/**
 * A form field value: primitives are stringified the way a browser form
 * serializes them; `Blob`/`File` values force multipart encoding. Arrays
 * produce repeated entries (multi-selects, checkbox groups), which
 * `formDataToRecord()` on the server groups back into arrays.
 */
export type FormFieldValue = string | number | boolean | Blob;
export type FormFields = Record<string, FormFieldValue | readonly FormFieldValue[]>;

export interface SubmitFormOptions<TContext = RegisteredContext> {
  /** Absolute or relative URL; relative paths resolve against `http://localhost`. Default `/`. */
  url?: string | URL;
  /** Default `POST`. */
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
export function createFormRequest(fields: FormFields, options: SubmitFormOptions = {}): Request {
  const url = new URL(options.url ?? "/", TEST_ORIGIN);
  const method = (options.method ?? "POST").toUpperCase();

  const entries: [string, FormFieldValue][] = [];
  for (const [name, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) {
      entries.push([name, entry as FormFieldValue]);
    }
  }

  const hasFile = entries.some(([, value]) => value instanceof Blob);
  const encoding = options.encoding ?? (hasFile ? "multipart" : "urlencoded");

  let body: FormData | URLSearchParams;
  if (encoding === "multipart") {
    const form = new FormData();
    for (const [name, value] of entries) {
      if (value instanceof Blob) {
        form.append(name, value);
      } else {
        form.append(name, String(value));
      }
    }
    body = form;
  } else {
    if (hasFile) {
      throw new Error(
        'submitForm(): Blob/File fields cannot be sent as "urlencoded". ' +
          'Use encoding: "multipart" (or omit encoding to switch automatically).',
      );
    }
    const search = new URLSearchParams();
    for (const [name, value] of entries) {
      search.append(name, String(value));
    }
    body = search;
  }

  // `Request` sets the matching Content-Type itself: multipart/form-data with
  // the boundary for FormData, application/x-www-form-urlencoded for
  // URLSearchParams — exactly what `defineApi()` sniffs to pick form parsing.
  return new Request(url, { method, headers: options.headers, body });
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
 * applies to real submissions.
 */
export async function submitForm<TContext = RegisteredContext>(
  handler: (args: ApiRouteArgs<TContext>) => Response | Promise<Response>,
  fields: FormFields,
  options: SubmitFormOptions<TContext> = {},
): Promise<Response> {
  const request = createFormRequest(fields, options as SubmitFormOptions);
  const args = createApiArgs<TContext>({
    request,
    params: options.params,
    context: options.context,
    route: options.route,
    signal: options.signal,
  });
  return handler(args);
}
