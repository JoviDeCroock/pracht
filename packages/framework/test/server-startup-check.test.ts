import { afterEach, describe, expect, it } from "vitest";

import { defineApp, handlePrachtRequest, route } from "../src/index.ts";
import { serverStartupCheck, setServerStartupCheck } from "../src/server.ts";

function request() {
  return handlePrachtRequest({
    app: defineApp({ routes: [route("/", "./routes/home.tsx", { render: "ssr" })] }),
    registry: {
      routeModules: { "./routes/home.tsx": async () => ({ Component: () => null }) },
    },
    request: new Request("http://localhost/"),
  });
}

afterEach(() => {
  setServerStartupCheck(Promise.resolve());
});

describe("server startup check", () => {
  it("holds requests until it passes", async () => {
    let pass!: () => void;
    setServerStartupCheck(new Promise<void>((resolve) => (pass = resolve)));

    let settled = false;
    const pending = request().then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    pass();
    expect((await pending).status).toBe(200);
  });

  it("fails every request, and the startup wait, once it fails", async () => {
    setServerStartupCheck(Promise.reject(new Error("nothing identifies the end user")));

    await expect(request()).rejects.toThrow("nothing identifies the end user");
    await expect(request()).rejects.toThrow("nothing identifies the end user");
    await expect(serverStartupCheck()).rejects.toThrow("nothing identifies the end user");
  });

  it("is not reported as unhandled before anything awaits it", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      setServerStartupCheck(Promise.reject(new Error("refused")));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
