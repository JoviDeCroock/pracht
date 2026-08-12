import type { StandardSchemaV1 } from "@standard-schema/spec";

export type ApiValidationSource = "body" | "query" | "params";
export type ApiValidationPathSegment = string | number;

export interface ApiValidationIssue {
  in: ApiValidationSource;
  message: string;
  path?: ApiValidationPathSegment[];
}

export interface ApiValidationErrorBody {
  error: "validation";
  issues: ApiValidationIssue[];
}

export type ParsedApiRequestBody =
  | { ok: true; value: unknown }
  | { ok: false; issue: ApiValidationIssue };

export function isApiValidationErrorBody(value: unknown): value is ApiValidationErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { error?: unknown }).error === "validation" &&
    Array.isArray((value as { issues?: unknown }).issues) &&
    (value as { issues: unknown[] }).issues.every(isApiValidationIssue)
  );
}

export function apiValidationErrorResponse(
  issues: ApiValidationIssue[],
  init?: { status?: number },
): Response {
  const body: ApiValidationErrorBody = {
    error: "validation",
    issues: issues.map((issue) => ({
      ...issue,
      path: issue.path?.map(normalizeValidationPathSegment),
    })),
  };
  return Response.json(body, { status: init?.status ?? 422 });
}

/** Reject values whose runtime representation would change over JSON. */
export function assertApiJsonValue(
  value: unknown,
  path = "$",
  ancestors: Set<object> = new Set(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`defineApi() handler returned a non-finite number at ${path}.`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`defineApi() handler returned a non-JSON value at ${path}.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`defineApi() handler returned a circular value at ${path}.`);
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`defineApi() handler returned a non-plain object at ${path}.`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`defineApi() handler returned symbol-keyed data at ${path}.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError(`defineApi() handler returned extra array data at ${path}.${key}.`);
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new TypeError(`defineApi() handler returned a sparse array at ${path}[${index}].`);
        }
        assertApiJsonValue(value[index], `${path}[${index}]`, ancestors);
      }
      return;
    }

    for (const [key, entry] of Object.entries(value)) {
      assertApiJsonValue(entry, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export async function validateStandardSchema(
  schema: StandardSchemaV1,
  value: unknown,
  source: ApiValidationSource,
): Promise<{ issues: null; value: unknown } | { issues: ApiValidationIssue[]; value?: never }> {
  let result = schema["~standard"].validate(value);
  if (result instanceof Promise) result = await result;

  if (result.issues) {
    return {
      issues: result.issues.map((issue) => ({
        in: source,
        message: issue.message,
        path: issue.path?.map((segment) =>
          normalizeValidationPathSegment(
            typeof segment === "object" && segment !== null ? segment.key : segment,
          ),
        ),
      })),
    };
  }
  return { issues: null, value: result.value };
}

export async function runApiSchema(
  schema: StandardSchemaV1,
  value: unknown,
  source: ApiValidationSource,
  issues: ApiValidationIssue[],
): Promise<unknown> {
  const result = await validateStandardSchema(schema, value, source);
  if (result.issues) {
    issues.push(...result.issues);
    return undefined;
  }
  return result.value;
}

export function searchParamsToRecord(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  return groupEntriesByKey(searchParams);
}

export function formDataToRecord(
  formData: FormData,
): Record<string, FormDataEntryValue | FormDataEntryValue[]> {
  return groupEntriesByKey(formData);
}

export async function readApiRequestBody(request: Request): Promise<ParsedApiRequestBody> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { ok: true, value: undefined };
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      return { ok: true, value: formDataToRecord(await request.formData()) };
    } catch {
      return { ok: false, issue: { in: "body", message: "Malformed form body" } };
    }
  }

  const text = await request.text();
  if (text === "") return { ok: true, value: undefined };

  if (contentType === "" || contentType.includes("json")) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, issue: { in: "body", message: "Malformed JSON body" } };
    }
  }
  return { ok: true, value: text };
}

function isApiValidationIssue(value: unknown): value is ApiValidationIssue {
  if (typeof value !== "object" || value === null) return false;
  const issue = value as { in?: unknown; message?: unknown; path?: unknown };
  return (
    (issue.in === "body" || issue.in === "query" || issue.in === "params") &&
    typeof issue.message === "string" &&
    (issue.path === undefined ||
      (Array.isArray(issue.path) &&
        issue.path.every(
          (segment) =>
            typeof segment === "string" ||
            (typeof segment === "number" && Number.isFinite(segment)),
        )))
  );
}

function normalizeValidationPathSegment(segment: PropertyKey): ApiValidationPathSegment {
  return typeof segment === "symbol" || (typeof segment === "number" && !Number.isFinite(segment))
    ? String(segment)
    : segment;
}

/** Single-pass grouping avoids repeated getAll() rescans and preserves __proto__. */
function groupEntriesByKey<TValue>(
  entries: Iterable<[string, TValue]>,
): Record<string, TValue | TValue[]> {
  const record = Object.create(null) as Record<string, TValue | TValue[]>;
  const repeated = new Set<string>();

  for (const [key, value] of entries) {
    if (!(key in record)) {
      record[key] = value;
    } else if (repeated.has(key)) {
      (record[key] as TValue[]).push(value);
    } else {
      repeated.add(key);
      record[key] = [record[key] as TValue, value];
    }
  }
  return record;
}
