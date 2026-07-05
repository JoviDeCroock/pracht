/**
 * "Did you mean" helpers for manifest wiring errors.
 *
 * When a route references an unknown shell, middleware, or route id, the
 * error message includes the closest registered name plus the full list of
 * registered names. A tiny internal edit-distance implementation keeps this
 * dependency-free.
 */

/** Classic Levenshtein edit distance using two rolling rows. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = Array.from<number>({ length: b.length + 1 });

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

/**
 * Return the candidate closest to `input`, or `undefined` when nothing is
 * close enough to be a plausible typo. The threshold scales with the input
 * length (roughly a third of it, minimum 2 edits).
 */
export function closestName(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = levenshteinDistance(input.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  const threshold = Math.max(2, Math.floor(input.length / 3));
  return bestDistance <= threshold ? best : undefined;
}

export interface UnknownNameErrorOptions {
  /** Singular label, e.g. `shell`. */
  kind: string;
  /** Plural label for the registered list. Defaults to `${kind}s`. */
  kindPlural?: string;
  /** The unknown name that was referenced. */
  name: string;
  /** All registered names of this kind. */
  registered: readonly string[];
  /** Where the bad reference lives, e.g. `route "/"`. */
  context?: string;
}

/**
 * Format an enriched wiring error, e.g.
 * `Unknown shell "pubic" for route "/". Did you mean "public"? Registered shells: public, app.`
 */
export function formatUnknownNameError(options: UnknownNameErrorOptions): string {
  const { kind, name, registered, context } = options;
  const kindPlural = options.kindPlural ?? `${kind}s`;

  let message = `Unknown ${kind} "${name}"${context ? ` for ${context}` : ""}.`;

  const suggestion = closestName(name, registered);
  if (suggestion) {
    message += ` Did you mean "${suggestion}"?`;
  }

  message +=
    registered.length > 0
      ? ` Registered ${kindPlural}: ${registered.join(", ")}.`
      : ` No ${kindPlural} are registered in defineApp().`;

  return message;
}
