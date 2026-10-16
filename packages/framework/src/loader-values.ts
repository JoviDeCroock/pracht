/**
 * Shared shape predicates for the loader-value walkers.
 *
 * `defer()` and `serverOnly()` both rebuild a loader result while replacing
 * marked values, and both must agree on what counts as traversable: a walker
 * that treats `Date` as a plain object would lose its prototype, and one that
 * disagreed with the other about array indices would rebuild the same object
 * two different ways depending on which marker it carried.
 */

export function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isArrayIndexKey(key: PropertyKey): key is string {
  if (typeof key !== "string" || key === "") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}
