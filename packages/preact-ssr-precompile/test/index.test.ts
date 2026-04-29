import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import { transformWithOxc } from "vite";
import { afterAll, describe, expect, it } from "vitest";

import { preactSsrPrecompile, transformPreactSsrJsx } from "../src/index.ts";

const repoTempDir = resolve(".tmp-preact-ssr-precompile-tests");
let moduleIndex = 0;

mkdirSync(repoTempDir, { recursive: true });

afterAll(() => {
  rmSync(repoTempDir, { force: true, recursive: true });
});

async function importCode(code: string): Promise<Record<string, unknown>> {
  const filename = join(repoTempDir, `module-${moduleIndex++}.mjs`);
  writeFileSync(filename, code);
  return import(`${pathToFileURL(filename).href}?t=${moduleIndex}`) as Promise<
    Record<string, unknown>
  >;
}

async function compileNormalJsx(source: string): Promise<string> {
  const result = await transformWithOxc(source, "baseline.jsx", {
    lang: "jsx",
    jsx: {
      runtime: "automatic",
      importSource: "preact",
    },
    sourcemap: false,
  });
  return result.code;
}

async function compilePrecompiledJsx(source: string): Promise<string> {
  const transformed = transformPreactSsrJsx(source, "precompiled.jsx");
  expect(transformed).toBeTruthy();
  const result = await transformWithOxc(transformed ?? source, "precompiled.jsx", {
    lang: "jsx",
    jsx: {
      runtime: "automatic",
      importSource: "preact",
    },
    sourcemap: false,
  });
  return result.code;
}

describe("preactSsrPrecompile", () => {
  it("precompiles safe DOM subtrees and preserves Preact SSR output", async () => {
    const source = `
export function view(props) {
  return (
    <main className="page" aria-hidden={props.hidden} draggable={props.drag}>
      Hello <span>{props.name}</span>
      {props.items.map((item) => <a href={item.href}>{item.label}</a>)}
      <br />
    </main>
  );
}
`;

    const normal = await importCode(await compileNormalJsx(source));
    const precompiledCode = await compilePrecompiledJsx(source);
    const precompiled = await importCode(precompiledCode);

    expect(precompiledCode).toContain("jsxTemplate");

    const renderProps = {
      drag: false,
      hidden: true,
      items: [
        { href: "/a?x=<y>", label: "A & B" },
        { href: "/b", label: "<B>" },
      ],
      name: "Jovi <dev>",
    };

    const renderNormal = normal.view as (input: typeof renderProps) => VNode;
    const renderPrecompiled = precompiled.view as (input: typeof renderProps) => VNode;

    expect(renderToString(renderPrecompiled(renderProps))).toBe(
      renderToString(renderNormal(renderProps)),
    );
  });

  it("falls back for elements with special Preact SSR semantics", async () => {
    const source = `
export const textarea = <textarea value="a&b" />;
export const select = <select value="b"><option value="a">A</option><option value="b">B</option></select>;
export const custom = <my-el fooBar="baz" />;
`;

    const normal = await importCode(await compileNormalJsx(source));
    const precompiledCode = await compilePrecompiledJsx(source);
    const precompiled = await importCode(precompiledCode);

    expect(precompiledCode).toContain('_jsx("textarea"');
    expect(precompiledCode).toContain('_jsx("select"');
    expect(precompiledCode).toContain('_jsx("my-el"');

    expect(renderToString(precompiled.textarea as VNode)).toBe(
      renderToString(normal.textarea as VNode),
    );
    expect(renderToString(precompiled.select as VNode)).toBe(
      renderToString(normal.select as VNode),
    );
    expect(renderToString(precompiled.custom as VNode)).toBe(
      renderToString(normal.custom as VNode),
    );
  });

  it("does not leave extra whitespace for omitted dynamic attributes", async () => {
    const source = `
export function view(props) {
  return <article key={props.id} className={props.className} href={props.href}>x</article>;
}
`;

    const normal = await importCode(await compileNormalJsx(source));
    const precompiled = await importCode(await compilePrecompiledJsx(source));

    const renderProps = { className: "card", href: null, id: "1" };
    const renderNormal = normal.view as (input: typeof renderProps) => VNode;
    const renderPrecompiled = precompiled.view as (input: typeof renderProps) => VNode;

    expect(renderToString(renderPrecompiled(renderProps))).toBe(
      renderToString(renderNormal(renderProps)),
    );
    expect(renderToString(renderPrecompiled(renderProps))).toBe(
      '<article class="card">x</article>',
    );
  });

  it("evaluates dynamic ARIA/enumerated attributes once", async () => {
    const source = `
let count = 0;
function next() {
  count++;
  return false;
}
export function view() {
  return <div draggable={next()} aria-hidden={next()}>x</div>;
}
export function getCount() {
  return count;
}
`;

    const precompiled = await importCode(await compilePrecompiledJsx(source));
    const view = precompiled.view as () => VNode;
    const getCount = precompiled.getCount as () => number;

    expect(renderToString(view())).toBe('<div draggable="false" aria-hidden="false">x</div>');
    expect(getCount()).toBe(2);
  });

  it("plugin transform runs only for SSR by default", async () => {
    const plugin = preactSsrPrecompile();
    const transform = (
      typeof plugin.transform === "function" ? plugin.transform : plugin.transform?.handler
    ) as any;
    expect(transform).toBeTypeOf("function");

    const source = "export const node = <div>x</div>;";
    const clientResult = await transform?.call({} as never, source, "route.jsx", { ssr: false });
    const serverResult = await transform?.call({} as never, source, "route.jsx", { ssr: true });

    expect(clientResult).toBeUndefined();
    expect(serverResult && typeof serverResult === "object" && "code" in serverResult).toBe(true);
  });
});
