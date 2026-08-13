import type { Plugin } from "vite";

const GRAPH_RUNTIME_STUB_PREFIX = "\0pracht:cloudflare-graph-runtime:";
const GRAPH_RUNTIME_STUBS: Record<string, string> = {
  "cloudflare:workers": [
    "function unavailable(api) { throw new Error(`cloudflare:workers ${api} is unavailable during graph inspection`); }",
    "function unavailableObject(api) {",
    "  const fail = (operation) => unavailable(`${api} ${operation}`);",
    "  const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');",
    "  const target = Object.create(null);",
    "  Object.defineProperty(target, inspectSymbol, { configurable: true, value() { return fail('inspection'); } });",
    "  return new Proxy(target, {",
    "    get(_target, property) {",
    "      if (property === inspectSymbol) return () => fail('inspection');",
    "      if (property === Symbol.toPrimitive) return () => fail('coercion');",
    "      return fail(`property ${String(property)} access`);",
    "    },",
    "    set(_target, property) { return fail(`property ${String(property)} assignment`); },",
    "    has(_target, property) { return fail(`property ${String(property)} membership check`); },",
    "    ownKeys() { return fail('property enumeration'); },",
    "    getOwnPropertyDescriptor(_target, property) { return fail(`property ${String(property)} descriptor inspection`); },",
    "    defineProperty(_target, property) { return fail(`property ${String(property)} definition`); },",
    "    deleteProperty(_target, property) { return fail(`property ${String(property)} deletion`); },",
    "    getPrototypeOf() { return fail('prototype inspection'); },",
    "    setPrototypeOf() { return fail('prototype mutation'); },",
    "    isExtensible() { return fail('extensibility inspection'); },",
    "    preventExtensions() { return fail('extension prevention'); },",
    "  });",
    "}",
    "export class RpcStub { constructor() { unavailable('RpcStub'); } }",
    "export class RpcTarget { constructor() { unavailable('RpcTarget'); } }",
    "export class WorkerEntrypoint { constructor() { unavailable('WorkerEntrypoint'); } }",
    "export class DurableObject { constructor() { unavailable('DurableObject'); } }",
    "export class WorkflowEntrypoint { constructor() { unavailable('WorkflowEntrypoint'); } }",
    "export function waitUntil() { return unavailable('waitUntil'); }",
    "export function withEnv() { return unavailable('withEnv'); }",
    "export function withExports() { return unavailable('withExports'); }",
    "export function withEnvAndExports() { return unavailable('withEnvAndExports'); }",
    "export const env = unavailableObject('env');",
    "export const exports = unavailableObject('exports');",
    "export const cache = { purge() { return unavailable('cache.purge'); } };",
    "export const tracing = { enterSpan() { return unavailable('tracing.enterSpan'); } };",
  ].join("\n"),
  "cloudflare:email": [
    "function unavailable(api) { throw new Error(`cloudflare:email ${api} is unavailable during graph inspection`); }",
    "export class EmailMessage { constructor() { unavailable('EmailMessage'); } }",
  ].join("\n"),
  "cloudflare:sockets":
    'export function connect() { throw new Error("cloudflare:sockets is unavailable during graph inspection"); }\n',
  "cloudflare:workflows": [
    "function unavailable(api) { throw new Error(`cloudflare:workflows ${api} is unavailable during graph inspection`); }",
    "export class WorkflowEntrypoint { constructor() { unavailable('WorkflowEntrypoint'); } }",
  ].join("\n"),
};

/**
 * Graph readers execute capability contracts in Vite's Node SSR runner. Keep
 * Cloudflare runtime imports resolvable there without starting workerd; code
 * that actually calls a platform API still fails loudly.
 */
export function cloudflareGraphRuntimeStubs(): Plugin {
  return {
    name: "pracht:cloudflare-graph-runtime-stubs",
    enforce: "pre",
    resolveId(source) {
      if (!source.startsWith("cloudflare:")) return;
      if (!(source in GRAPH_RUNTIME_STUBS)) {
        throw new Error(
          `Pracht graph inspection has no Node stub for "${source}". ` +
            `Supported Cloudflare runtime modules: ${Object.keys(GRAPH_RUNTIME_STUBS).join(", ")}.`,
        );
      }
      return `${GRAPH_RUNTIME_STUB_PREFIX}${source}`;
    },
    load(id) {
      if (!id.startsWith(GRAPH_RUNTIME_STUB_PREFIX)) return;
      return GRAPH_RUNTIME_STUBS[id.slice(GRAPH_RUNTIME_STUB_PREFIX.length)];
    },
  };
}
