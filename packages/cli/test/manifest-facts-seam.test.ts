import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAst } from "vite";
import { describe, expect, it } from "vitest";

// Seam guard: the CLI learns what the manifest says from the resolved app
// graph or the pracht plugin's manifest facts, not from its own text scan of
// routes, route exports, or manifest markers. The guard is behavioural: every
// regular expression and every string search in the CLI source is run against
// manifest text, and one that reacts to the manifest's own vocabulary is a
// second reader, whatever it looks like.
const srcDir = join(import.meta.dirname, "../src");

function sources(dir: string): { name: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [{ name: path, text: readFileSync(path, "utf-8") }] : [];
  });
}

/**
 * Manifest text and the same text with its pracht vocabulary renamed. A
 * reader of that vocabulary tells the two apart; a generic scanner (a string
 * literal, a property scan) treats them alike.
 */
const PROBES: [string, string][] = [
  ['route("/docs", "./routes/docs.tsx")', 'other("/docs", "./routes/docs.tsx")'],
  ['group({ shell: "app" }, [])', 'other({ shell: "app" }, [])'],
  ["export const __PRACHT_EJECTED_PAGES_LAYOUT__ = true", "export const __OTHER_MARKER__ = true"],
  ["export function head() {}", "export function other() {}"],
  ["export const head = () => ({})", "export const other = () => ({})"],
];

/** Vocabulary a string search must not look for. */
const VOCABULARY = ["route(", "group(", "__PRACHT_EJECTED_PAGES_LAYOUT__", " head", "head("];

const SEARCH_METHODS = new Set([
  "endsWith",
  "includes",
  "indexOf",
  "lastIndexOf",
  "match",
  "matchAll",
  "search",
  "split",
  "startsWith",
]);

type Node = { type?: string; [key: string]: unknown };

function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  const current = node as Node;
  if (typeof current.type === "string") visit(current);
  for (const value of Object.values(current)) {
    if (value && typeof value === "object") walk(value, visit);
  }
}

function stringValue(node: unknown): string | null {
  const literal = node as { type?: string; value?: unknown } | undefined;
  return literal?.type === "Literal" && typeof literal.value === "string" ? literal.value : null;
}

/** Every regex the module can build from literals, and every string it searches text for. */
function readers(text: string): { regexes: RegExp[]; searches: string[] } {
  const program = parseAst(text, { lang: "ts" });
  const regexes: RegExp[] = [];
  const searches: string[] = [];
  walk(program, (node) => {
    const regex = (node as { regex?: { pattern: string; flags: string } }).regex;
    if (node.type === "Literal" && regex) {
      regexes.push(new RegExp(regex.pattern, regex.flags.replace("g", "")));
      return;
    }
    if (node.type === "NewExpression" || node.type === "CallExpression") {
      const callee = node.callee as Node & { name?: string; property?: { name?: string } };
      const args = node.arguments as unknown[];
      if (callee?.type === "Identifier" && callee.name === "RegExp") {
        const pattern = stringValue(args[0]);
        if (pattern !== null) regexes.push(new RegExp(pattern));
        return;
      }
      if (callee?.type === "MemberExpression" && SEARCH_METHODS.has(callee.property?.name ?? "")) {
        const search = stringValue(args[0]);
        if (search !== null) searches.push(search);
      }
    }
  });
  return { regexes, searches };
}

describe("manifest facts in the CLI", () => {
  it("has no regex or string reader of the manifest's vocabulary", () => {
    const offenders: string[] = [];
    for (const { name, text } of sources(srcDir)) {
      const { regexes, searches } = readers(text);
      for (const regex of regexes) {
        for (const [vocabulary, renamed] of PROBES) {
          if (regex.test(vocabulary) !== regex.test(renamed)) {
            offenders.push(`${name}: ${regex} reads ${JSON.stringify(vocabulary)}`);
          }
        }
      }
      for (const search of searches) {
        if (VOCABULARY.some((word) => search.includes(word))) {
          offenders.push(`${name}: searches for ${JSON.stringify(search)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("catches the readers it is meant to", () => {
    const seeded = [
      "const RE = /export\\s+const\\s+__PRACHT_EJECTED_PAGES_LAYOUT__\\s*=\\s*true/;",
      "const count = source.match(/\\broute\\s*\\(/g)?.length;",
      'const hasHead = new RegExp("export\\\\s+function\\\\s+head\\\\b").test(source);',
      'const ejected = source.includes("__PRACHT_EJECTED_PAGES_LAYOUT__");',
    ];
    for (const text of seeded) {
      const { regexes, searches } = readers(text);
      const caught =
        regexes.some((regex) =>
          PROBES.some(([vocabulary, renamed]) => regex.test(vocabulary) !== regex.test(renamed)),
        ) || searches.some((search) => VOCABULARY.some((word) => search.includes(word)));
      expect(caught, text).toBe(true);
    }
  });
});
