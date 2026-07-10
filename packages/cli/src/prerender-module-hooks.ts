/**
 * Node module hooks that stub `cloudflare:*` platform modules while
 * `pracht build` imports the built server bundle for SSG prerendering.
 *
 * Edge server bundles keep platform-scheme imports external (they only exist
 * inside workerd), so importing the bundle in Node would otherwise fail
 * before the prerender pass can run. Nothing that touches these classes runs
 * during prerendering — SSG only reads the resolved route manifest and
 * renders page components.
 *
 * Registered from the build command via `module.register()`.
 */
const STUB_PREFIX = "pracht-cloudflare-stub:";

const STUB_SOURCES: Record<string, string> = {
  "cloudflare:workers": [
    "export class WorkerEntrypoint {}",
    "export class DurableObject {}",
    "export class WorkflowEntrypoint {}",
    "export class RpcTarget {}",
    "export const env = {};",
    'export const cache = { purge() { throw new Error("cache.purge is not available during prerendering"); } };',
    "",
  ].join("\n"),
  "cloudflare:email": "export class EmailMessage {}\n",
  "cloudflare:sockets":
    'export function connect() { throw new Error("cloudflare:sockets is not available during prerendering"); }\n',
};

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
