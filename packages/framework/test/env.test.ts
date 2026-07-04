import { afterEach, describe, expect, it } from "vitest";

import { filterPublicEnv, PRACHT_PUBLIC_ENV_PREFIX } from "../src/env.ts";
import { serverEnv, setServerEnv } from "../src/env-server.ts";

describe("filterPublicEnv", () => {
  it("keeps only PRACHT_PUBLIC_-prefixed string values", () => {
    const result = filterPublicEnv({
      DATABASE_URL: "postgres://user:pass@host/db",
      PRACHT_PUBLIC_APP_NAME: "demo",
      PRACHT_PUBLIC_API_BASE: "https://api.example.com",
      SESSION_SECRET: "hunter2",
      VITE_LEGACY: "still-not-public-for-pracht",
    });

    expect(result).toEqual({
      PRACHT_PUBLIC_APP_NAME: "demo",
      PRACHT_PUBLIC_API_BASE: "https://api.example.com",
    });
  });

  it("drops non-string values even when prefixed", () => {
    const result = filterPublicEnv({
      PRACHT_PUBLIC_FLAG: true,
      PRACHT_PUBLIC_COUNT: 3,
      PRACHT_PUBLIC_NAME: "ok",
    });

    expect(result).toEqual({ PRACHT_PUBLIC_NAME: "ok" });
  });

  it("returns an empty object for undefined sources", () => {
    expect(filterPublicEnv(undefined)).toEqual({});
  });
});

describe("publicEnv", () => {
  it("is frozen and built from the ambient env source", async () => {
    const { publicEnv } = await import("../src/env.ts");
    expect(Object.isFrozen(publicEnv)).toBe(true);
    for (const key of Object.keys(publicEnv)) {
      expect(key.startsWith(PRACHT_PUBLIC_ENV_PREFIX)).toBe(true);
    }
  });
});

describe("serverEnv", () => {
  afterEach(() => {
    setServerEnv(undefined);
    delete process.env.PRACHT_TEST_SERVER_VALUE;
  });

  it("falls back to process.env on Node runtimes", () => {
    process.env.PRACHT_TEST_SERVER_VALUE = "from-process";
    expect((serverEnv as Record<string, unknown>).PRACHT_TEST_SERVER_VALUE).toBe("from-process");
    expect("PRACHT_TEST_SERVER_VALUE" in serverEnv).toBe(true);
  });

  it("prefers an installed platform env over process.env", () => {
    process.env.PRACHT_TEST_SERVER_VALUE = "from-process";
    setServerEnv({ PRACHT_TEST_SERVER_VALUE: "from-binding", MY_KV: { get: () => null } });

    const env = serverEnv as Record<string, unknown>;
    expect(env.PRACHT_TEST_SERVER_VALUE).toBe("from-binding");
    expect(env.MY_KV).toBeTypeOf("object");
    expect(Object.keys(env)).toEqual(["PRACHT_TEST_SERVER_VALUE", "MY_KV"]);
  });

  it("is read-only", () => {
    expect(() => {
      (serverEnv as Record<string, unknown>).INJECTED = "nope";
    }).toThrow(/read-only/);
  });
});
