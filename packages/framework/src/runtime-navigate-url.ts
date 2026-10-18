/**
 * Client navigations to a URL built in the browser: the query setter and a
 * `<Form clientNavigation>` GET submission. Kept apart from `<Form>` so a form
 * that never opts in does not ship it; the form imports it on first use.
 *
 * @internal
 */

export interface NavigateToUrlOptions {
  replace?: boolean;
  preserveScroll?: boolean;
}

/**
 * Navigate to a same-origin URL through the client router when the page has
 * one. Absolute, so a path that begins with `//` is never read as a host.
 */
export function navigateToUrl(url: URL, options?: NavigateToUrlOptions): Promise<void> {
  if (window.__PRACHT_NAVIGATE__) return window.__PRACHT_NAVIGATE__(url.href, options);
  if (options?.replace) window.location.replace(url.href);
  else window.location.href = url.href;
  return Promise.resolve();
}

/** Line breaks as a form submission encodes them. */
function toCrlf(value: string): string {
  return value.replace(/\r\n?|\n/g, "\r\n");
}

/**
 * Navigate to the URL a native GET submission would load: the action resolved
 * against the document base (none means this page), its query replaced by the
 * fields, file inputs sent by name, and line breaks as CRLF. Returns false,
 * without navigating, for an action on another origin.
 */
export async function navigateFormGet(action: string | null, formData: FormData): Promise<boolean> {
  const url = new URL(action || location.href, document.baseURI);
  if (url.origin !== location.origin) return false;
  url.search = new URLSearchParams(
    [...formData].map(([name, value]) => [
      toCrlf(name),
      typeof value === "string" ? toCrlf(value) : value.name,
    ]),
  ).toString();
  await navigateToUrl(url);
  return true;
}
