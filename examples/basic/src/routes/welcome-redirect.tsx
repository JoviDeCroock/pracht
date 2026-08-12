import { redirect, type LoaderArgs } from "@pracht/core";
import type { I18nRequestContext } from "@pracht/i18n";

import { i18n, type AppLocale } from "../i18n/index.ts";

// The unprefixed detector route: the i18n middleware already resolved the
// locale (cookie first if the visitor chose one before, then
// Accept-Language), so this loader only forwards to the prefixed URL.
export async function loader({ context, request }: LoaderArgs<I18nRequestContext<AppLocale>>) {
  throw redirect(i18n.localePath("/welcome", context.locale), { request });
}

export function Component() {
  // Never rendered — the loader always redirects.
  return null;
}
