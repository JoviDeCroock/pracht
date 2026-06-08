import { describe, expect, it } from "vitest";

import { createVoidServerEntryModule, voidAdapter } from "../src/index.ts";

describe("voidAdapter", () => {
  it("uses Void as the build target id", () => {
    expect(voidAdapter().id).toBe("void");
  });

  it("keeps the Cloudflare worker entry shape Void deploy can package", () => {
    const source = createVoidServerEntryModule({
      createContextFrom: "/src/server/context.ts",
      workerExportsFrom: "/src/cloudflare.ts",
    });

    expect(source).toContain(
      'import { createContext as createPrachtContext } from "/src/server/context.ts";',
    );
    expect(source).toContain('import { withRuntimeEnv as withVoidRuntimeEnv } from "void/_env";');
    expect(source).toContain("return withVoidRuntimeEnv(env, async () => {");
    // The runtime-env wrapper must be closed before the default export, or the
    // generated module is a syntax error (regression guard for the Cloudflare
    // entry adding extra default-export handlers).
    expect(source).toContain("\n  });\n}\n\nexport default {");
    expect(source).toContain("await createPrachtContext({ request, env, executionContext })");
    expect(source).toContain('export * from "/src/cloudflare.ts";');
    expect(source).toContain('env?.["ASSETS"]');
    expect(source).toContain("handlePrachtRequest({");
  });
});
