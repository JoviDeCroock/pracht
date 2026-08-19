import { redirect, type BaseRouteArgs } from "@pracht/core";

import { i18n } from "../i18n/index.ts";

function sameOriginPath(value: FormDataEntryValue | null, base: URL, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  try {
    const target = new URL(value, base);
    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Locale switch for the prefix-free strategy (`/greeting`): the page keeps one
 * URL, so the choice is persisted in the locale cookie instead of the path.
 *
 * Without JavaScript this is a native form POST that ends in a 303 back to the
 * page; with JavaScript `<Form>` intercepts it, reads the redirect target
 * through Pracht's enhanced-form handshake, and re-runs the loader — which
 * now sees the new cookie. Mutation API routes are
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
  // attacker-controllable, and URL parsing can normalize slashes, backslashes,
  // dot segments, or ASCII whitespace before navigation.
  const next = form.get("next");
  const target = sameOriginPath(next, url, "/greeting");

  const response = redirect(target, { request, status: 303 });
  // Same name and attributes the i18n middleware reads on the next request
  // (`Secure` inferred from the request url, like the middleware does).
  response.headers.append("set-cookie", i18n.localeCookie(locale, { url }));
  return response;
}
