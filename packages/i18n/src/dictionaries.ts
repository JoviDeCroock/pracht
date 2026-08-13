/**
 * Flat-key locale dictionaries with lazy per-locale loading, typed keys
 * derived from the default locale's shape, `{param}` interpolation, and
 * plural selection via `Intl.PluralRules`.
 *
 * The loaded value (`Messages`) is a plain JSON-serializable object — return
 * it (or a subset) from a route loader and call `t()` / `tPlural()` on the
 * client with the exact same semantics.
 */

/** A flat dictionary: string keys to string templates. */
export type DictionaryShape = Record<string, string>;

/** A locale module: either the dictionary itself or a `default` export. */
export type DictionaryModule<D extends DictionaryShape = DictionaryShape> = { default: D } | D;

export type DictionaryLoader<D extends DictionaryShape = DictionaryShape> = () =>
  | Promise<DictionaryModule<D>>
  | DictionaryModule<D>;

type UnwrapDictionaryModule<M> = M extends { default: infer D extends DictionaryShape }
  ? D
  : M extends DictionaryShape
    ? M
    : never;

type DictionaryOf<TLoader> = TLoader extends () => infer R
  ? UnwrapDictionaryModule<Awaited<R>>
  : never;

/**
 * A loaded dictionary: every key of the default locale's shape resolved to a
 * string (missing keys fall back to the default locale at merge time), plus
 * the reserved `$locale` key carrying the resolved locale. `$`-prefixed keys
 * are reserved and stripped from user dictionaries.
 */
export type Messages<D extends DictionaryShape = DictionaryShape> = {
  readonly [K in keyof D as K extends `$${string}` ? never : K]: string;
} & { readonly $locale: string };

/** All translatable keys of a loaded dictionary. */
export type TranslationKey<M> = Exclude<keyof M & string, `$${string}`>;

/**
 * Base keys usable with `tPlural()`: keys for which the default locale
 * defines at least `<key>.other`.
 */
export type PluralKey<M> = {
  [K in keyof M & string]: K extends `$${string}`
    ? never
    : K extends `${infer Base}.other`
      ? Base
      : never;
}[keyof M & string];

export interface DictionariesOptions<L extends string> {
  /** Locale whose dictionary defines the key set and fills missing keys. */
  defaultLocale: L;
}

export interface Dictionaries<D extends DictionaryShape, L extends string> {
  readonly locales: readonly L[];
  readonly defaultLocale: L;
  /**
   * Load (and cache) one locale's dictionary, merged over the default
   * locale's dictionary so every key resolves. Unknown locales fall back to
   * the default locale — only registered locales are ever loaded.
   */
  load(locale: L | (string & {})): Promise<Messages<D>>;
}

function unwrapModule(module: DictionaryModule): DictionaryShape {
  if (
    module !== null &&
    typeof module === "object" &&
    "default" in module &&
    module.default !== null &&
    typeof module.default === "object"
  ) {
    return module.default as DictionaryShape;
  }
  return module as DictionaryShape;
}

function sanitizeDictionary(raw: DictionaryShape): Record<string, string> {
  // A normal object treats `__proto__` assignment specially instead of
  // creating an own property. Translation keys are arbitrary flat strings,
  // so keep the sanitized cache free of inherited/special keys entirely.
  const dictionary = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(raw)) {
    // `$`-prefixed keys are reserved for the framework (`$locale`).
    if (key.startsWith("$")) continue;
    const value = raw[key];
    if (typeof value === "string") dictionary[key] = value;
  }
  return dictionary;
}

/**
 * Register one lazy loader per locale. The default locale's dictionary shape
 * provides the typed key set for `t()` / `tPlural()`:
 *
 * ```ts
 * export const dictionaries = createDictionaries(
 *   {
 *     en: () => import("./locales/en.ts"),
 *     nl: () => import("./locales/nl.ts"),
 *   },
 *   { defaultLocale: "en" },
 * );
 * ```
 */
export function createDictionaries<
  TLoaders extends Record<string, DictionaryLoader>,
  TDefault extends keyof TLoaders & string,
>(
  loaders: TLoaders,
  options: DictionariesOptions<TDefault>,
): Dictionaries<DictionaryOf<TLoaders[TDefault]>, keyof TLoaders & string> {
  const locales = Object.freeze(Object.keys(loaders)) as readonly (keyof TLoaders & string)[];
  const { defaultLocale } = options;
  if (!Object.hasOwn(loaders, defaultLocale)) {
    throw new TypeError(
      `createDictionaries: defaultLocale "${defaultLocale}" has no registered loader. Registered locales: ${locales.join(", ")}.`,
    );
  }

  const cache = new Map<string, Promise<Record<string, string>>>();

  function loadRaw(locale: string): Promise<Record<string, string>> {
    let pending = cache.get(locale);
    if (!pending) {
      const loader = loaders[locale] as DictionaryLoader;
      pending = Promise.resolve()
        .then(() => loader())
        .then((module) => sanitizeDictionary(unwrapModule(module)));
      cache.set(locale, pending);
      // A failed import must not poison the cache forever — evict so the
      // next request retries.
      pending.catch(() => {
        if (cache.get(locale) === pending) cache.delete(locale);
      });
    }
    return pending;
  }

  async function load(locale: string): Promise<Messages<DictionaryOf<TLoaders[TDefault]>>> {
    const resolved = Object.hasOwn(loaders, locale) ? locale : defaultLocale;
    const defaults = await loadRaw(defaultLocale);
    const dictionary = resolved === defaultLocale ? defaults : await loadRaw(resolved);
    return { ...defaults, ...dictionary, $locale: resolved } as Messages<
      DictionaryOf<TLoaders[TDefault]>
    >;
  }

  return { locales, defaultLocale, load };
}

export type InterpolationParams = Record<string, string | number | boolean>;

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_.]+)\}/g;

/**
 * Replace `{name}` placeholders in a single pass. Values are substituted
 * verbatim and never re-scanned, so a param value containing `{...}` cannot
 * trigger further interpolation. Unknown placeholders are left as-is, and
 * only own, primitive params are read (no prototype walking).
 */
export function interpolate(template: string, params?: InterpolationParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) => {
    if (!Object.hasOwn(params, name)) return match;
    const value = params[name];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return match;
  });
}

function readMessage(messages: Record<string, unknown>, key: string): string | undefined {
  if (typeof key !== "string" || key === "$locale") return undefined;
  if (!Object.hasOwn(messages, key)) return undefined;
  const value = messages[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Translate a key with optional `{param}` interpolation.
 *
 * Keys are typed from the default locale's dictionary shape. Missing-locale
 * keys are already handled at `load()` time (merged over the default
 * locale); if a dynamic key is genuinely absent everywhere, the key itself
 * is returned so the UI degrades to something greppable instead of throwing.
 */
export function t<M extends Messages>(
  messages: M,
  key: TranslationKey<M>,
  params?: InterpolationParams,
): string {
  const template = readMessage(messages, key);
  if (template === undefined) return String(key);
  return interpolate(template, params);
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function selectPluralCategory(locale: string, count: number): Intl.LDMLPluralRule {
  if (typeof count !== "number" || !Number.isFinite(count)) return "other";
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    try {
      rules = new Intl.PluralRules(locale);
    } catch {
      // `$locale` normally comes from `createDictionaries` registration, but
      // a hand-built messages object could carry garbage — fail safe.
      rules = new Intl.PluralRules("en");
    }
    pluralRulesCache.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * Translate a plural key. The dictionary declares one entry per
 * `Intl.PluralRules` category the locale needs (`<key>.one`, `<key>.other`,
 * and e.g. `<key>.few` / `<key>.many` for Polish); `tPlural` selects the
 * category for `count` in the dictionary's locale and falls back to
 * `<key>.other` when the category entry is missing. `{count}` is available
 * as an interpolation param automatically.
 */
export function tPlural<M extends Messages>(
  messages: M,
  key: PluralKey<M>,
  count: number,
  params?: InterpolationParams,
): string {
  const category = selectPluralCategory(messages.$locale, count);
  const template =
    readMessage(messages, `${key}.${category}`) ?? readMessage(messages, `${key}.other`);
  if (template === undefined) return String(key);
  return interpolate(template, { ...params, count });
}
