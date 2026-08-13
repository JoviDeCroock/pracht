import { redirect, type BaseRouteArgs } from "@pracht/core";

import { i18n } from "../i18n/index.ts";

/**
 * Locale switch for the prefix-free strategy (`/greeting`): the page keeps one
 * URL, so the choice is persisted in the locale cookie instead of the path.
 *
 * Without JavaScript this is a native form POST that ends in a 303 back to the
 * page; with JavaScript `<Form>` intercepts it, follows the 303, and re-runs
 * the loader — which now sees the new cookie. Mutation API routes are
 * same-origin-checked by the framework (`api.requireSameOrigin`), so no CSRF
 * token is needed here.
 */
export async function POST({ request, url }: BaseRouteArgs) {
  const form = await request.formData();
  const locale = form.get("locale");
  if (!i18n.isLocale(locale)) {
    return new Response("Unknown locale", { status: 400 });
  }

  // Only ever bounce back to one of our own paths: a submitted `next` is
  // attacker-controllable, and `/\evil.com` or `//evil.com` would leave the
  // origin. `redirect()` also rejects unsafe schemes and CRLF.
  const next = form.get("next");
  const target =
    typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : ("/greeting" as const);

  const response = redirect(target, { request, status: 303 });
  // Same name and attributes the i18n middleware reads on the next request
  // (`Secure` inferred from the request url, like the middleware does).
  response.headers.append("set-cookie", i18n.localeCookie(locale, { url }));
  return response;
}
