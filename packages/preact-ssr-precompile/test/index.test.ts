import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { VNode } from "preact";
import { renderToString } from "preact-render-to-string";
import { transformWithOxc } from "vite";
import { afterAll, describe, expect, it } from "vitest";

import { preactSsrPrecompile, transformPreactSsrJsx } from "../src/index.ts";

const repoTempDir = mkdtempSync(join(tmpdir(), "preact-ssr-precompile-tests-"));
let moduleIndex = 0;

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

type RenderFn<TProps> = (props: TProps) => VNode;

async function expectPrecompiledRenderMatches<TProps>(
  source: string,
  propsCases: TProps[],
  options: { expectedHtml?: string[]; expectCodeIncludes?: string[] } = {},
): Promise<string> {
  const normal = await importCode(await compileNormalJsx(source));
  const precompiledCode = await compilePrecompiledJsx(source);
  const precompiled = await importCode(precompiledCode);

  for (const snippet of options.expectCodeIncludes ?? ["jsxTemplate"]) {
    expect(precompiledCode).toContain(snippet);
  }

  const renderNormal = normal.view as RenderFn<TProps>;
  const renderPrecompiled = precompiled.view as RenderFn<TProps>;

  for (const [index, props] of propsCases.entries()) {
    const precompiledHtml = renderToString(renderPrecompiled(props));
    expect(precompiledHtml).toBe(renderToString(renderNormal(props)));
    if (options.expectedHtml?.[index] != null) {
      expect(precompiledHtml).toBe(options.expectedHtml[index]);
    }
  }

  return precompiledCode;
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

  it("evaluates dynamic stringified boolean attributes once", async () => {
    const source = `
let count = 0;
function next() {
  count++;
  return false;
}
export function view() {
  return <div draggable={next()} aria-hidden={next()} data-active={next()}>x</div>;
}
export function getCount() {
  return count;
}
`;

    const precompiled = await importCode(await compilePrecompiledJsx(source));
    const view = precompiled.view as () => VNode;
    const getCount = precompiled.getCount as () => number;

    expect(renderToString(view())).toBe(
      '<div draggable="false" aria-hidden="false" data-active="false">x</div>',
    );
    expect(getCount()).toBe(3);
  });

  it("matches upstream attribute casing, literal, and escaping cases", async () => {
    const source = `
export function view(props) {
  return (
    <div
      htmlFor="field"
      className="card"
      acceptCharset="utf-8"
      httpEquiv="refresh"
      tabIndex={-1}
      data-count={100}
      title={'a&<"b'}
    >
      {'"a&<"'}
      <label className={props.labelClass}>{props.label}</label>
    </div>
  );
}
`;

    await expectPrecompiledRenderMatches(
      source,
      [{ label: "Name & <value>", labelClass: "label&main" }],
      {
        expectedHtml: [
          '<div for="field" class="card" accept-charset="utf-8" http-equiv="refresh" tabindex="-1" data-count="100" title="a&amp;&lt;&quot;b">&quot;a&amp;&lt;&quot;<label class="label&amp;main">Name &amp; &lt;value></label></div>',
        ],
      },
    );
  });

  it("matches upstream boolean and dynamic attribute cases", async () => {
    const source = `
export function view(props) {
  return (
    <section>
      <input type="checkbox" checked={props.checked} required={true} disabled={false} />
      <div data-static data-disabled={false} f-client-nav={props.clientNav} data-enabled={props.enabled} draggable={props.draggable} aria-hidden={props.hidden}>x</div>
    </section>
  );
}
`;

    await expectPrecompiledRenderMatches(
      source,
      [
        { checked: false, clientNav: false, draggable: false, enabled: false, hidden: true },
        { checked: true, clientNav: true, draggable: true, enabled: true, hidden: false },
      ],
      {
        expectedHtml: [
          '<section><input type="checkbox" required/><div data-static="true" data-disabled="false" data-enabled="false" draggable="false" aria-hidden="true">x</div></section>',
          '<section><input type="checkbox" checked required/><div data-static="true" data-disabled="false" f-client-nav data-enabled="true" draggable="true" aria-hidden="false">x</div></section>',
        ],
      },
    );
  });

  it("matches upstream namespace, member tag, key, and ref cases", async () => {
    const source = `
const ctx = {
  Provider(props) {
    return <section>{props.children}</section>;
  },
};
function Foo(props) {
  return <article>{props.children}</article>;
}
export function view(props) {
  return (
    <main>
      <a xlink:href={props.href} xmlLang="en">link</a>
      <foo:bar baz="qux">namespaced</foo:bar>
      <ctx.Provider value={null}><span key="child-key" ref={props.refValue}>member</span></ctx.Provider>
      <Foo key={props.keyValue}>component</Foo>
    </main>
  );
}
`;

    const precompiledCode = await expectPrecompiledRenderMatches(
      source,
      [{ href: "/docs?q=<x>", keyValue: "component-key", refValue: "ignored" }],
      {
        expectedHtml: [
          '<main><a xlink:href="/docs?q=&lt;x>" xml:lang="en">link</a><foo:bar baz="qux">namespaced</foo:bar><section><span>member</span></section><article>component</article></main>',
        ],
        expectCodeIncludes: [
          '_jsx("foo:bar"',
          "_jsx(ctx.Provider",
          '_jsxAttr("key"',
          '_jsxAttr("ref"',
        ],
      },
    );

    expect(precompiledCode).toContain("_jsx(Foo");
  });

  it("matches upstream static child merging cases for component fallbacks", async () => {
    const source = `
function Foo(props) {
  return <section>{props.children}</section>;
}
export function view() {
  return <Foo>foo{" "}bar{' '}{2}{true}{false}baz<div />qux</Foo>;
}
`;

    await expectPrecompiledRenderMatches(source, [{}], {
      expectedHtml: ["<section>foo bar 2baz<div></div>qux</section>"],
      expectCodeIncludes: ["_jsx(Foo", "jsxTemplate"],
    });
  });

  it("falls back for upstream spread and dangerouslySetInnerHTML cases", async () => {
    const source = `
export function view(props) {
  return (
    <main>
      <div foo="1" {...props.spread} bar="2">hello</div>
      <div dangerouslySetInnerHTML={{ __html: props.html }} />
    </main>
  );
}
`;

    const precompiledCode = await expectPrecompiledRenderMatches(
      source,
      [{ html: "<span>raw&ok</span>", spread: { baz: "3", children: undefined } }],
      {
        expectedHtml: [
          '<main><div foo="1" baz="3" bar="2">hello</div><div><span>raw&ok</span></div></main>',
        ],
        expectCodeIncludes: ["...props.spread"],
      },
    );

    expect(precompiledCode).toContain("dangerouslySetInnerHTML");
  });

  it("matches upstream component children and JSX attribute cases", async () => {
    const source = `
function Foo(props) {
  return <article data-kind={props.kind}>{props.children}</article>;
}
function Bar(props) {
  return <strong>{props.children}</strong>;
}
export function view(props) {
  return (
    <Foo kind="wrap" bar={<div>hello</div>}>
      <span>hello</span>foo<Bar>{props.name}</Bar>
    </Foo>
  );
}
`;

    const precompiledCode = await expectPrecompiledRenderMatches(
      source,
      [{ name: "Jovi & team" }],
      {
        expectedHtml: [
          '<article data-kind="wrap"><span>hello</span>foo<strong>Jovi &amp; team</strong></article>',
        ],
        expectCodeIncludes: ["jsxTemplate", "_jsx(Foo"],
      },
    );

    expect(precompiledCode).toContain("bar: _jsxTemplate");
  });

  it("matches upstream fragment and whitespace normalization cases", async () => {
    const source = `
function Foo(props) {
  return <div>{props.children}</div>;
}
export function view(props) {
  return (
    <Foo>
      <>
        foo
        <span />
        {props.value}
      </>
    </Foo>
  );
}
`;

    await expectPrecompiledRenderMatches(source, [{ value: "&bar" }], {
      expectedHtml: ["<div>foo<span></span>&amp;bar</div>"],
    });
  });

  it("honors upstream skip element and dynamic prop options", async () => {
    const source = `
export function view(props) {
  return <div className="outer"><img id="hero" className="image" src={props.src} /><a href={props.href}>link</a></div>;
}
`;

    const transformed = transformPreactSsrJsx(source, "precompiled.jsx", {
      dynamicProps: ["class", "className"],
      skipElements: ["a", "img"],
    });
    expect(transformed).toBeTruthy();
    expect(transformed).toContain('_jsxAttr("class"');
    expect(transformed).toContain('_jsx("img"');
    expect(transformed).toContain('_jsx("a"');

    const normal = await importCode(await compileNormalJsx(source));
    const compiled = await transformWithOxc(transformed ?? source, "precompiled.jsx", {
      lang: "jsx",
      jsx: {
        runtime: "automatic",
        importSource: "preact",
      },
      sourcemap: false,
    });
    const precompiled = await importCode(compiled.code);
    const props = { href: "/home?x=<y>", src: "/hero.png" };

    expect(renderToString((precompiled.view as RenderFn<typeof props>)(props))).toBe(
      renderToString((normal.view as RenderFn<typeof props>)(props)),
    );
  });

  it("honors upstream import source option and avoids generated name collisions", () => {
    const source = `
const _jsxTemplate = "taken";
const $$_tpl_1 = "taken";
export const view = <div>hello</div>;
`;

    const transformed = transformPreactSsrJsx(source, "precompiled.jsx", {
      importSource: "custom-preact",
    });

    expect(transformed).toBeTruthy();
    expect(transformed).toContain('from "custom-preact/jsx-runtime"');
    expect(transformed).toContain("jsxTemplate as _jsxTemplate_1");
    expect(transformed).toContain("const $$_tpl_1_1");
    expect(transformed).toContain("_jsxTemplate_1($$_tpl_1_1)");
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
