import { describe, expect, it } from "vitest";

import {
  formatPrerenderBindingReads,
  load,
  resolve,
  takePrerenderBindingReads,
} from "../src/prerender-module-hooks.ts";

const nextResolve = (specifier: string) => ({ url: `resolved:${specifier}` });
const nextLoad = (url: string) => ({ format: "module", source: `loaded:${url}` });

async function importStub(specifier: string): Promise<Record<string, any>> {
  const { url } = resolve(specifier, {}, nextResolve) as { url: string };
  const { source } = load(url, {}, nextLoad) as { source: string };
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

describe("prerender module hooks", () => {
  it("short-circuits known cloudflare modules to stub URLs", () => {
    const result = resolve("cloudflare:workers", {}, nextResolve) as {
      url: string;
      shortCircuit: boolean;
    };
    expect(result.url).toBe("pracht-cloudflare-stub:cloudflare:workers");
    expect(result.shortCircuit).toBe(true);
  });

  it("keeps Worker classes subclassable and constructible", async () => {
    const workers = await importStub("cloudflare:workers");
    for (const name of [
      "DurableObject",
      "WorkerEntrypoint",
      "WorkflowEntrypoint",
      "RpcTarget",
      "RpcStub",
      "RpcPromise",
      "RpcProperty",
      "ServiceStub",
    ]) {
      const Base: new (ctx: unknown, env: unknown) => object = workers[name];
      class Subclass extends Base {}
      expect(new Subclass({}, {})).toBeInstanceOf(Base);
    }
    const { EmailMessage } = await importStub("cloudflare:email");
    expect(new EmailMessage()).toBeInstanceOf(EmailMessage);
  });

  it("exports a working NonRetryableError from cloudflare:workflows", async () => {
    const { NonRetryableError } = await importStub("cloudflare:workflows");
    const error = new NonRetryableError("stop retrying");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NonRetryableError");
    expect(error.message).toBe("stop retrying");
    expect(new NonRetryableError("custom", "ImportFailed").name).toBe("ImportFailed");
  });

  it("fails clearly when a request-time runtime API is called", async () => {
    const workers = await importStub("cloudflare:workers");
    expect(() => workers.waitUntil(Promise.resolve())).toThrow(
      /cloudflare:workers waitUntil\(\) is not available while prerendering\. Use the waitUntil function your loader/,
    );
    expect(() => workers.withEnv({}, () => {})).toThrow(
      /cloudflare:workers withEnv\(\) is not available while prerendering.*render: "ssr"/,
    );
    expect(() => workers.cache.purge({ tags: ["x"] })).toThrow(/cache\.purge\(\) is not available/);
    const sockets = await importStub("cloudflare:sockets");
    expect(() => sockets.connect("example.com:443")).toThrow(
      /cloudflare:sockets connect\(\) is not available while prerendering/,
    );
  });

  it("returns undefined for bindings and records which ones were read", async () => {
    const { env, exports: workerExports } = await importStub("cloudflare:workers");
    const reads = takePrerenderBindingReads();

    expect(env.DB).toBeUndefined();
    expect("API_URL" in env).toBe(false);
    expect(workerExports.Counter).toBeUndefined();
    // Enumeration, spreading, promise resolution, and prototype lookups are
    // not binding reads.
    expect(Object.keys(env)).toEqual([]);
    expect({ ...env }).toEqual({});
    expect(await Promise.resolve(env)).toBe(env);
    expect(typeof env.toString).toBe("function");

    expect([...reads].sort()).toEqual(["env.API_URL", "env.DB", "exports.Counter"]);
    expect(formatPrerenderBindingReads(reads)).toBe(
      "Prerendering read env.API_URL, env.DB, exports.Counter from cloudflare:workers. " +
        "Cloudflare bindings do not exist while pracht build prerenders pages in Node, so each " +
        'read returned undefined. Render pages that need bindings with render: "ssr".',
    );

    // A new prerender pass starts from an empty set.
    expect(takePrerenderBindingReads().size).toBe(0);
    expect(formatPrerenderBindingReads(new Set())).toBeNull();
  });

  it("throws a descriptive error for unknown cloudflare modules", () => {
    expect(() => resolve("cloudflare:unknown-thing", {}, nextResolve)).toThrow(
      /no prerender stub for "cloudflare:unknown-thing"/,
    );
  });

  it("delegates non-cloudflare specifiers to the next resolver", () => {
    expect(resolve("node:fs", {}, nextResolve)).toEqual({ url: "resolved:node:fs" });
    expect(load("file:///app.js", {}, nextLoad)).toEqual({
      format: "module",
      source: "loaded:file:///app.js",
    });
  });
});
