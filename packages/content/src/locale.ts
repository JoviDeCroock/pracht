import type { ContentLocaleOptions } from "./types.ts";

// Locale selection shared by the authoring collection and the generated
// runtime snapshot. Both index candidates by locale and must agree on the
// requested locale, the fallback order, and which locales are supported, so
// the logic lives here instead of being mirrored twice. It stays free of
// `node:*` imports so `@pracht/content/runtime` keeps working on workerd and
// other filesystem-free deployment targets.

/** Map key standing in for a document that carries no locale at all. */
export const NO_LOCALE = "\0";

export type NormalizedContentLocales = ContentLocaleOptions & { supported: readonly string[] };

/** The only thing locale selection needs from an indexed candidate. */
interface LocalizedCandidate {
  locale?: string;
}

export function assertSupportedLocale(
  locale: string,
  locales: ContentLocaleOptions,
  label: string,
): void {
  if (!locales.supported.includes(locale)) {
    throw new TypeError(`${label} uses unsupported content locale ${JSON.stringify(locale)}.`);
  }
}

export function resolveRequestedLocale<TCandidate extends LocalizedCandidate>(
  requested: string | undefined,
  locales: NormalizedContentLocales | undefined,
  candidates: Map<string, TCandidate>,
  inferFromRoute: boolean,
): string | undefined {
  if (!locales) return undefined;
  const locale = requested ?? locales.default;
  assertSupportedLocale(locale, locales, "lookup");
  if (
    inferFromRoute &&
    requested === undefined &&
    !candidates.has(locale) &&
    candidates.size === 1
  ) {
    return [...candidates.values()][0].locale;
  }
  return locale;
}

export function resolveLocaleOrder(
  requested: string | undefined,
  allowFallback: boolean,
  locales: NormalizedContentLocales | undefined,
): Array<string | undefined> {
  if (!locales || !requested) return [undefined];
  if (!allowFallback) return [requested];

  const configured = locales.fallback;
  let fallbacks: readonly string[];
  if (typeof configured === "string") {
    fallbacks = requested === locales.default ? [] : [configured];
  } else if (Array.isArray(configured)) {
    fallbacks = requested === locales.default ? [] : configured;
  } else if (configured) {
    const record = configured as Readonly<Record<string, string | readonly string[]>>;
    const value = Object.hasOwn(record, requested) ? record[requested] : undefined;
    fallbacks = typeof value === "string" ? [value] : (value ?? []);
  } else {
    fallbacks = requested === locales.default ? [] : [locales.default];
  }

  const order = [requested];
  for (const locale of fallbacks) {
    assertSupportedLocale(locale, locales, `fallback for ${JSON.stringify(requested)}`);
    if (!order.includes(locale)) order.push(locale);
  }
  return order;
}
