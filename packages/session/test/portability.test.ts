/**
 * The package's one hard portability promise: it runs on every adapter. That
 * means WebCrypto and nothing else — a single `node:crypto` import would work
 * fine in the unit tests and in `pracht dev`, then fail at deploy time on
 * Cloudflare Workers, which is the worst place to find out.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(packageRoot, "dist/index.mjs");

/** Strip comments so a `node:buffer` mentioned in prose is not a finding. */
function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^[ \t]*\/\/.*$/gm, "");
}

function moduleSpecifiers(source: string): string[] {
  const code = stripComments(source);
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("runs on every adapter", () => {
  it("imports no Node built-ins from src", () => {
    for (const file of sourceFiles(join(packageRoot, "src"))) {
      for (const specifier of moduleSpecifiers(readFileSync(file, "utf-8"))) {
        expect(
          specifier.startsWith("node:"),
          `${file} imports "${specifier}"; @pracht/session must use WebCrypto only`,
        ).toBe(false);
      }
    }
  });

  it("imports nothing but @pracht/core from the built output", () => {
    // `pnpm build` runs before the unit tests in `verify`; when it has not,
    // the src check above is still authoritative.
    if (!existsSync(distEntry)) {
      throw new Error(
        `${distEntry} is missing. Run \`pnpm build\` (or \`pnpm --dir packages/session run build\`) first.`,
      );
    }
    const specifiers = moduleSpecifiers(readFileSync(distEntry, "utf-8"));
    expect(specifiers.filter((specifier) => specifier.startsWith("node:"))).toEqual([]);
    expect([...new Set(specifiers)]).toEqual(["@pracht/core"]);
  });

  it("uses only the WebCrypto surface every runtime implements", () => {
    const code = sourceFiles(join(packageRoot, "src"))
      .map((file) => stripComments(readFileSync(file, "utf-8")))
      .join("\n");
    // The lookbehind keeps the `./crypto.ts` import specifiers out of it.
    const cryptoUses = [...code.matchAll(/(?<!["'./\w])crypto\.(\w+)/g)].map((match) => match[1]);
    expect([...new Set(cryptoUses)].sort()).toEqual(["getRandomValues", "subtle"]);
  });
});

describe("WebCrypto round trip under this runtime", () => {
  it("seals and opens through the platform's crypto.subtle", async () => {
    // Node's WebCrypto is the vitest default environment; the same assertions
    // are what the Playwright build specs exercise on workerd and on the
    // Vercel/Netlify bundles.
    const { createSessionStorage } = await import("../src/index.ts");
    const sessions = createSessionStorage<{ userId: string }>({
      cookie: { name: "session", secrets: ["a-secret-of-sufficient-length"] },
    });
    const session = await sessions.getSession(null);
    session.set("userId", "u_1");
    const setCookie = await sessions.commitSession(session);
    const restored = await sessions.getSession(setCookie.split(";")[0]);
    expect(restored.get("userId")).toBe("u_1");
  });
});
