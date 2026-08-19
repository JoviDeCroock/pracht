import { redirect, type LoaderArgs } from "@pracht/core";
import type { I18nRequestContext } from "@pracht/i18n";

import { i18n, type AppLocale } from "../i18n/index.ts";

// The unprefixed detector route: the i18n middleware already resolved the
// locale (cookie first if the visitor chose one before, then
// Accept-Language), so this loader only forwards to the prefixed URL.
//
// `return` the redirect instead of throwing it: a thrown Response
// short-circuits past the middleware chain, so the i18n middleware could
// not stamp `Vary: Cookie, Accept-Language` on it — and without that a
// shared cache could replay one visitor's locale redirect to everyone.
export async function loader({ context, request }: LoaderArgs<I18nRequestContext<AppLocale>>) {
  return redirect(i18n.localePath("/welcome", context.locale), { request });
}

export function Component() {
  // Never rendered — the loader always redirects.
  return null;
}
