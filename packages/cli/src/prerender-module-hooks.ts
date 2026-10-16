/**
 * Node module hooks that stub `cloudflare:*` platform modules while
 * `pracht build` imports the built server bundle for SSG prerendering.
 *
 * Edge server bundles keep platform-scheme imports external (they only exist
 * inside workerd), so importing the bundle in Node would otherwise fail
 * before the prerender pass can run. Every runtime export must exist here:
 * a missing named export fails the whole build at link time, even when
 * nothing calls it during prerendering.
 *
 * The stubs favour keeping valid Worker code buildable: classes stay
 * constructible and subclassable, and `env`/`exports` behave like empty
 * objects because Cloudflare allows reading bindings at module top level.
 * Binding reads are recorded (see {@link takePrerenderBindingReads}) so the
 * build can name them instead of silently prerendering with `undefined`.
 * Functions that need a live request (`waitUntil`, `withEnv`, `cache.purge`,
 * `connect`, ...) throw a descriptive error when called.
 *
 * The export surface mirrors the graph-command stubs in
 * `@pracht/adapter-cloudflare` (`GRAPH_RUNTIME_STUBS`); a test enumerates the
 * real workerd modules and checks both sets against them.
 *
 * Registered from the build command via `module.register()`.
 */
const STUB_PREFIX = "pracht-cloudflare-stub:";

/**
 * Global slot shared between the stub modules (evaluated on the main thread)
 * and the build command, which reports the bindings read while prerendering.
 */
const BINDING_READS_KEY = "pracht.cloudflarePrerenderBindingReads";

const PRERENDER_HINT =
  "Cloudflare runtime APIs only exist inside workerd, and pracht build prerenders SSG and ISG pages in Node; " +
  'render a route that needs them with render: "ssr".';

function unavailableHelper(moduleName: string): string {
  return [
    "function unavailable(api, hint) {",
    `  throw new Error(\`${moduleName} \${api} is not available while prerendering. \${hint ?? ${JSON.stringify(PRERENDER_HINT)}}\`);`,
    "}",
  ].join("\n");
}

const STUB_SOURCES: Record<string, string> = {
  "cloudflare:workers": [
    unavailableHelper("cloudflare:workers"),
    `const bindingReads = (globalThis[Symbol.for(${JSON.stringify(BINDING_READS_KEY)})] ??= new Set());`,
    "function recordedBindings(name) {",
    "  const record = (property) => {",
    "    if (typeof property !== 'string' || property === 'then' || property === 'toJSON') return;",
    "    if (property in Object.prototype) return;",
    "    bindingReads.add(`${name}.${property}`);",
    "  };",
    "  return new Proxy({}, {",
    "    get(target, property, receiver) { record(property); return Reflect.get(target, property, receiver); },",
    "    has(target, property) { record(property); return Reflect.has(target, property); },",
    "  });",
    "}",
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "export class RpcTarget {}",
    "export class RpcStub {}",
    "export class RpcPromise {}",
    "export class RpcProperty {}",
    "export class ServiceStub {}",
    "export const env = recordedBindings('env');",
    "export const exports = recordedBindings('exports');",
    "export function waitUntil() {",
    "  return unavailable('waitUntil()', 'Use the waitUntil function your loader, middleware, or API handler receives in its arguments.');",
    "}",
    "export function withEnv() { return unavailable('withEnv()'); }",
    "export function withExports() { return unavailable('withExports()'); }",
    "export function withEnvAndExports() { return unavailable('withEnvAndExports()'); }",
    "export const cache = { purge() { return unavailable('cache.purge()'); } };",
    "export const tracing = { enterSpan() { return unavailable('tracing.enterSpan()'); } };",
    "",
  ].join("\n"),
  "cloudflare:workflows": [
    "export class NonRetryableError extends Error {",
    "  constructor(message, name = 'NonRetryableError') { super(message); this.name = name; }",
    "}",
    // Not a runtime export of `cloudflare:workflows`, but kept so older
    // imports keep linking; `cloudflare:workers` is where it lives.
    "export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    "",
  ].join("\n"),
  "cloudflare:email": "export class EmailMessage {}\n",
  "cloudflare:sockets": [
    unavailableHelper("cloudflare:sockets"),
    "export function connect() { return unavailable('connect()'); }",
    "",
  ].join("\n"),
  "cloudflare:pipelines": "export class PipelineTransformationEntrypoint {}\n",
  "cloudflare:node": [
    unavailableHelper("cloudflare:node"),
    "export function httpServerHandler() { return unavailable('httpServerHandler()'); }",
    "export function handleAsNodeRequest() { return unavailable('handleAsNodeRequest()'); }",
    "",
  ].join("\n"),
};

/** The `cloudflare:*` modules the prerender pass can stub. */
export const PRERENDER_STUB_MODULES: readonly string[] = Object.keys(STUB_SOURCES);

/**
 * Start recording binding reads for a prerender pass and return the live set.
 * Reads made while the server bundle was imported (module top level of entry
 * classes and context factories) are discarded: they are legal on Cloudflare
 * and cannot reach prerendered HTML by themselves.
 */
export function takePrerenderBindingReads(): Set<string> {
  const slot = globalThis as Record<symbol, unknown>;
  const key = Symbol.for(BINDING_READS_KEY);
  let reads = slot[key] as Set<string> | undefined;
  if (!(reads instanceof Set)) {
    reads = new Set();
    slot[key] = reads;
  }
  reads.clear();
  return reads;
}

/** The build warning for bindings read while prerendering, or `null`. */
export function formatPrerenderBindingReads(reads: ReadonlySet<string>): string | null {
  if (reads.size === 0) return null;
  const names = [...reads].sort().join(", ");
  return (
    `Prerendering read ${names} from cloudflare:workers. Cloudflare bindings do not exist ` +
    "while pracht build prerenders pages in Node, so each read returned undefined. " +
    'Render pages that need bindings with render: "ssr".'
  );
}

interface ResolveResult {
  url: string;
  shortCircuit: boolean;
}

interface LoadResult {
  format: string;
  source: string;
  shortCircuit: boolean;
}

export function resolve(
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => unknown,
): unknown {
  if (specifier.startsWith("cloudflare:")) {
    if (!(specifier in STUB_SOURCES)) {
      throw new Error(
        `pracht build has no prerender stub for "${specifier}". ` +
          "SSG prerendering imports the server bundle in Node, where Cloudflare " +
          "platform modules do not exist. Please report this so the stub list " +
          "can be extended.",
      );
    }
    return { url: `${STUB_PREFIX}${specifier}`, shortCircuit: true } satisfies ResolveResult;
  }
  return nextResolve(specifier, context);
}

export function load(
  url: string,
  context: unknown,
  nextLoad: (url: string, context: unknown) => unknown,
): unknown {
  if (url.startsWith(STUB_PREFIX)) {
    const specifier = url.slice(STUB_PREFIX.length);
    return {
      format: "module",
      source: STUB_SOURCES[specifier] ?? "",
      shortCircuit: true,
    } satisfies LoadResult;
  }
  return nextLoad(url, context);
}
