/**
 * Seam guard for the router's document exits and staleness check.
 *
 * Every way `router.ts` hands a URL to the browser goes through
 * `leaveToDocument()`, which owns replace semantics, the static-fallback loop
 * guard, and the dev log. The exits used to be written inline, and each review
 * found one that lacked a rule the others had. A new raw `location.*` exit
 * fails here; route it through `leaveToDocument()` instead.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/router.ts", import.meta.url), "utf-8");

/** The source text of the top-level or nested function `name`, braces included. */
function functionText(text: string, signature: RegExp): string {
  const match = signature.exec(text);
  if (!match) throw new Error(`no ${signature} in router.ts`);
  const open = text.indexOf("{", text.indexOf(")", match.index));
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) return text.slice(match.index, index + 1);
  }
  throw new Error(`unbalanced ${signature}`);
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const RAW_EXITS = [
  /location\.href\s*=(?!=)/,
  /location\.replace\(/,
  /location\.assign\(/,
  /location\.reload\(/,
];

describe("router.ts document exits", () => {
  const leave = functionText(source, /\nfunction leaveToDocument\(/);

  it("has one exit function that owns every raw location exit", () => {
    expect(leave).toMatch(/location\.href\s*=/);
    expect(leave).toMatch(/location\.replace\(/);
    expect(leave).toMatch(/location\.reload\(/);
  });

  it("assigns no location outside leaveToDocument()", () => {
    const rest = stripComments(source.replace(leave, ""));
    for (const pattern of RAW_EXITS) {
      const lines = rest.split("\n").filter((line) => pattern.test(line));
      expect(lines, `${pattern} outside leaveToDocument()`).toEqual([]);
    }
  });
});

describe("navigate() staleness", () => {
  const navigate = stripComments(functionText(source, /\n {2}async function navigate\(/));
  const lines = navigate.split("\n");

  it("checks stale() after every await", () => {
    const awaits = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /\bawait\b/.test(line))
      // Following an internal redirect returns straight after.
      .filter(({ line }) => !/await navigate\(/.test(line));
    expect(awaits.length).toBeGreaterThan(0);
    for (const { line, index } of awaits) {
      const following = lines.slice(index, index + 9).join("\n");
      expect(following, `no stale() check after: ${line.trim()}`).toMatch(
        /if \(stale\(navigation\)\) return;/,
      );
    }
  });

  it("checks stale() first in the catch of the route-state await", () => {
    expect(navigate).toMatch(/\} catch \{\s*if \(stale\(navigation\)\) return;/);
  });
});
