import { describe, expect, it } from "vitest";

import { exportsMiddleware } from "../src/middleware-export-source.ts";

describe("exportsMiddleware", () => {
  it.each([
    ["export const middleware: MiddlewareFn = async (a, n) => n();", true],
    ["export function middleware(a, n) { return n(); }", true],
    ["export async function middleware(a, n) { return n(); }", true],
    ["const mw = 1;\nexport { mw as middleware };", true],
    ["const middleware = 1;\nexport { middleware };", true],
    ["export const { middleware } = createAuth();", true],
    ["export const { mw: middleware } = createAuth();", true],
    // A type annotation sits between the pattern and `=` in a .ts module.
    ["export const { middleware }: Handlers = createAuth();", true],
    ["export const [middleware]: Fn[] = createAuth();", true],
    // Nested patterns bind on the value side.
    ["export const { auth: { middleware } } = createAuth();", true],
    ["export const { middleware: { inner } } = createAuth();", false],
    ["export const { middleware = fallback } = createAuth();", true],
    ["export const [a, middleware] = createAuth();", true],
    // `{ middleware: mw }` binds `mw` — the same trap as `middleware as default`.
    ["export const { middleware: mw } = createAuth();", false],
    ["export const [mw] = createAuth();", false],
    ['export * from "./shared.ts";', true],
    ["export { a, mw as middleware, b };", true],
    // `middleware as default` exports `default`, not `middleware` — the exact
    // mistake this check exists to catch.
    ["const middleware = 1;\nexport { middleware as default };", false],
    ["export default async (a, n) => n();", false],
    ["export const authMiddleware = 1;", false],
    ["export { a, middleware as thing, b };", false],
    // Comments and strings are masked, so neither can fake an export.
    ["// export const middleware = 1;\nexport default 1;", false],
    ['const doc = "export const middleware";\nexport default 1;', false],
  ])("classifies %j as %s", (source, expected) => {
    expect(exportsMiddleware(source)).toBe(expected);
  });
});
