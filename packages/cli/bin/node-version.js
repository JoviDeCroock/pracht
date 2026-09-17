// Kept in its own module, imported by `bin/pracht.js` before the CLI itself,
// so the version check is testable without spawning a second Node. Nothing
// here may import anything newer than `node:fs`: the whole point is to run on
// the old Node that cannot instantiate the rest of the CLI.

/**
 * The message to print when this Node is too old for `engines.node`, or `null`
 * when it is supported. `required` is an `engines.node` range; only its
 * minimum matters, because pracht never declares an upper bound.
 */
export function unsupportedNodeMessage(version, required) {
  const minimum = String(required).replace(/^\D*/, "");
  if (meetsMinimum(version, minimum)) return null;

  return (
    `pracht requires Node >= ${minimum} (found ${version}).\n` +
    "Upgrade Node, or pin it for your build image with an .nvmrc file — " +
    "Cloudflare Pages, Netlify, and most CI images read it to pick a version."
  );
}

/** Numeric `major.minor.patch` comparison; a missing or unparsable part counts as 0. */
export function meetsMinimum(actual, minimum) {
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);

  for (let index = 0; index < 3; index++) {
    const left = actualParts[index] ?? 0;
    const right = minimumParts[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function versionParts(version) {
  return String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}
