import { describe, expect, it } from "vitest";

import { WHOLE_ENV_READ, scanEnvironmentReferences } from "../src/static-environment.ts";

describe("scanEnvironmentReferences", () => {
  it("applies the shared public, built-in, and allowlist policy", () => {
    expect(
      scanEnvironmentReferences(
        `use(process.env.SECRET, import.meta.env.PRACHT_PUBLIC_URL, import.meta.env.MODE, process.env.ALLOWED);`,
        new Set(["ALLOWED"]),
      ),
    ).toEqual([{ accessor: "process.env", name: "SECRET" }]);
  });

  it("reports optional, bracket, and whole-object reads in source order", () => {
    expect(
      scanEnvironmentReferences(
        `use(import.meta.env?.VITE_TOKEN, process.env["SECRET"], import.meta.env["MODE"]);`,
      ),
    ).toEqual([
      { accessor: "import.meta.env", name: "VITE_TOKEN" },
      { accessor: "process.env", name: "SECRET" },
      { accessor: "import.meta.env", name: WHOLE_ENV_READ },
    ]);
  });

  it("ignores comments and literal text but scans template expressions", () => {
    expect(
      scanEnvironmentReferences(`
        // process.env.COMMENT
        const text = "import.meta.env.STRING";
        const pattern = /process.env.REGEX/;
        const value = \`prefix \${process.env.REAL}\`;
      `),
    ).toEqual([{ accessor: "process.env", name: "REAL" }]);
  });
});
