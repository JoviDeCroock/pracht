const HEADER_CRLF_RE = /[\r\n]/;

/** Reject response-splitting characters consistently across Web runtimes. */
export function assertSafeHeaderValue(name: string, value: string): void {
  if (HEADER_CRLF_RE.test(value)) {
    throw new Error(`Refused to set header "${name}": value contains CR or LF`);
  }
}

/** Validate user-provided values before applying them to platform Headers. */
export function applyHeaders(headers: Headers, init: HeadersInit): void {
  for (const [key, value] of iterateHeaderInit(init)) {
    assertSafeHeaderValue(key, value);
  }
  new Headers(init).forEach((value, key) => headers.set(key, value));
}

/** Append one case-insensitive Vary member without duplicating it. */
export function appendVaryHeader(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }

  const values = current
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (values.includes("*") || values.includes(value.toLowerCase())) return;
  headers.set("vary", `${current}, ${value}`);
}

function* iterateHeaderInit(init: HeadersInit): Iterable<[string, string]> {
  if (init instanceof Headers) {
    for (const entry of init.entries()) yield entry;
    return;
  }
  if (Array.isArray(init)) {
    for (const entry of init) {
      if (entry && entry.length >= 2) yield [entry[0], entry[1]];
    }
    return;
  }
  for (const [key, value] of Object.entries(init as Record<string, string>)) {
    yield [key, value];
  }
}
