/**
 * Read a `Response` body as JSON. The response is cloned first, so the same
 * `Response` can be read again by later assertions. Throws with the raw body
 * text when the payload is not valid JSON.
 */
export async function readJson<TValue = unknown>(response: Response): Promise<TValue> {
  const text = await response.clone().text();
  try {
    return JSON.parse(text) as TValue;
  } catch {
    throw new Error(
      `Expected a JSON response body, got (status ${response.status}): ${text || "<empty>"}`,
    );
  }
}

export interface RedirectResult {
  status: number;
  location: string;
}

/**
 * Read a redirect `Response` — as produced by `redirect()` from
 * `@pracht/core` or any hand-built 3xx — into `{ status, location }`.
 * Throws when the response is not a redirect or carries no `Location` header.
 */
export function readRedirect(response: Response): RedirectResult {
  if (response.status === 304) {
    throw new Error(
      "Expected a redirect response, got status 304 (Not Modified is not a redirect)",
    );
  }
  if (response.status < 300 || response.status > 399) {
    throw new Error(`Expected a redirect response, got status ${response.status}`);
  }
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(
      `Expected a Location header on the ${response.status} redirect response, found none`,
    );
  }
  return { status: response.status, location };
}
