import { beforeEach, describe, expect, it, vi } from "vitest";

async function loadWorkerModule() {
  vi.resetModules();
  return import("../src/worker.ts");
}

describe("createPrachtHandler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("fails clearly when no pracht app has been registered", async () => {
    const { createPrachtHandler } = await loadWorkerModule();
    const pracht = createPrachtHandler();

    expect(() => pracht.fetch(new Request("https://example.com/"), {}, { waitUntil() {} })).toThrow(
      "createPrachtHandler() has no pracht app to serve",
    );
  });

  it("serves through the registered app with the handler's context factory", async () => {
    const { createPrachtHandler, registerPrachtWorker } = await loadWorkerModule();
    const createContext = () => ({ user: "ada" });
    // The app module evaluates before pracht registers; the app is looked up
    // per request.
    const withContext = createPrachtHandler({ createContext });
    const plain = createPrachtHandler();
    const calls: unknown[][] = [];
    registerPrachtWorker(async (...args) => {
      calls.push(args);
      return new Response("pracht");
    });
    const request = new Request("https://example.com/");
    const env = { KV: {} };
    const ctx = { waitUntil() {} };

    // `fetch` does not depend on `this`, so it can be passed around or spread.
    const { fetch } = withContext;
    await expect(fetch(request, env, ctx).then((r) => r.text())).resolves.toBe("pracht");
    await plain.fetch(request, env, ctx);

    expect(calls).toEqual([
      [request, env, ctx, createContext],
      [request, env, ctx, undefined],
    ]);
  });
});
