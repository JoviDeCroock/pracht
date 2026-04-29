import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderToString } from "preact-render-to-string";
import { transformWithOxc } from "vite";

import { transformPreactSsrJsx } from "../dist/index.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
const tempDir = join(benchDir, "..", ".tmp-bench");
const iterations = Number.parseInt(process.env.BENCH_ITERATIONS ?? "50000", 10);
const warmupIterations = Number.parseInt(process.env.BENCH_WARMUP ?? "5000", 10);

if (!Number.isFinite(iterations) || iterations <= 0) {
  throw new Error("BENCH_ITERATIONS must be a positive integer.");
}
if (!Number.isFinite(warmupIterations) || warmupIterations < 0) {
  throw new Error("BENCH_WARMUP must be a non-negative integer.");
}

const source = String.raw`
export function Page({ features, title, user }) {
  return (
    <main className="marketing-page" data-user={user.id} aria-hidden={false}>
      <header className="hero">
        <p className="eyebrow">Preact-first SSR</p>
        <h1>{title}</h1>
        <p>
          Rendered for {user.name} with {features.length} framework features.
        </p>
      </header>
      <section className="feature-grid">
        {features.map((feature) => (
          <article
            key={feature.id}
            className={feature.highlight ? "card card-highlight" : "card"}
            data-kind={feature.kind}
          >
            <div className="card-copy">
              <h2>{feature.title}</h2>
              <p>{feature.description}</p>
              <a href={feature.href} aria-label={feature.title}>
                Explore {feature.title}
              </a>
            </div>
            <ul className="tag-list">
              {feature.tags.map((tag) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>
      <footer>
        <p>Static shell with dynamic data, attributes, links, and lists.</p>
      </footer>
    </main>
  );
}
`;

const props = {
  title: "Pracht server rendering benchmark",
  user: { id: "ada&lovelace", name: "Ada <Lovelace>" },
  features: Array.from({ length: 24 }, (_, index) => ({
    description: `Feature ${index} renders mostly static HTML with dynamic text & attributes.`,
    highlight: index % 5 === 0,
    href: `/features/${index}?q=<preact>&kind=${index % 3}`,
    id: `feature-${index}`,
    kind: index % 2 === 0 ? "server" : "client",
    tags: ["ssr", "preact", `feature-${index}`],
    title: `Feature ${index}`,
  })),
};

const normalCode = await compileNormalJsx(source, "normal.jsx");
const precompiledJsx = transformPreactSsrJsx(source, "precompiled.jsx");
if (!precompiledJsx) throw new Error("Precompile transform did not modify the benchmark source.");
const precompiledCode = await compileNormalJsx(precompiledJsx, "precompiled.jsx");

const normalModule = await importCode("normal.mjs", normalCode);
const precompiledModule = await importCode("precompiled.mjs", precompiledCode);

const normalHtml = renderToString(normalModule.Page(props));
const precompiledHtml = renderToString(precompiledModule.Page(props));
if (normalHtml !== precompiledHtml) {
  throw new Error(
    [
      "Precompiled render output differs from normal JSX output.",
      `Normal:      ${normalHtml.slice(0, 500)}`,
      `Precompiled: ${precompiledHtml.slice(0, 500)}`,
    ].join("\n"),
  );
}

const normal = runRenderBenchmark("normal JSX", normalModule.Page);
const precompiled = runRenderBenchmark("precompiled JSX", precompiledModule.Page);
const speedup = normal.ms / precompiled.ms;

console.log("\nPreact renderToString JSX precompile benchmark");
console.log("------------------------------------------------");
console.log(`HTML length: ${normalHtml.length.toLocaleString()} bytes`);
console.log(
  `Iterations:  ${iterations.toLocaleString()} (warmup ${warmupIterations.toLocaleString()})`,
);
console.log(
  `Transform:   ${precompiledCode.includes("jsxTemplate") ? "jsxTemplate present" : "jsxTemplate missing"}`,
);
console.log("");
printResult(normal);
printResult(precompiled);
console.log("");
console.log(`Speedup:     ${speedup.toFixed(2)}x`);

rmSync(tempDir, { force: true, recursive: true });

async function compileNormalJsx(code, id) {
  const result = await transformWithOxc(code, id, {
    lang: "jsx",
    jsx: {
      runtime: "automatic",
      importSource: "preact",
    },
    sourcemap: false,
  });
  return result.code;
}

async function importCode(filename, code) {
  mkdirSync(tempDir, { recursive: true });
  const filePath = join(tempDir, filename);
  writeFileSync(filePath, code, "utf-8");
  return import(`${pathToFileURL(filePath).href}?t=${Date.now()}`);
}

function runRenderBenchmark(name, render) {
  let checksum = 0;
  for (let index = 0; index < warmupIterations; index++) {
    checksum += renderToString(render(props)).length;
  }

  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    checksum += renderToString(render(props)).length;
  }
  const ms = performance.now() - start;

  return {
    checksum,
    ms,
    name,
    ops: iterations / (ms / 1000),
  };
}

function printResult(result) {
  console.log(
    `${result.name.padEnd(16)} ${result.ops
      .toLocaleString(undefined, {
        maximumFractionDigits: 0,
      })
      .padStart(12)} ops/sec  ${result.ms.toFixed(1).padStart(8)} ms  checksum ${result.checksum}`,
  );
}
