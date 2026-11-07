import { describe, expect, it } from "vitest";

import { convertShell, hasPackageManagerVariants } from "../src/utils/package-managers";

const variants = (code: string) => ({
  npm: convertShell(code, "npm"),
  yarn: convertShell(code, "yarn"),
  bun: convertShell(code, "bun"),
});

describe("package-manager variants", () => {
  it("installs packages", () => {
    expect(variants("pnpm add @pracht/session")).toEqual({
      npm: "npm install @pracht/session",
      yarn: "yarn add @pracht/session",
      bun: "bun add @pracht/session",
    });
    expect(variants("pnpm add -D drizzle-kit")).toEqual({
      npm: "npm install -D drizzle-kit",
      yarn: "yarn add -D drizzle-kit",
      bun: "bun add --dev drizzle-kit",
    });
  });

  it("forwards create flags after -- for npm only", () => {
    expect(variants("pnpm create pracht my-app --adapter=cf --yes")).toEqual({
      npm: "npm create pracht@latest my-app -- --adapter=cf --yes",
      yarn: "yarn create pracht my-app --adapter=cf --yes",
      bun: "bunx create-pracht my-app --adapter=cf --yes",
    });
    expect(convertShell("pnpm create pracht my-app", "npm")).toBe(
      "npm create pracht@latest my-app",
    );
  });

  it("runs scripts and binaries, keeping other lines and comments", () => {
    const block =
      "cd my-app\npnpm run deploy\npnpm dev   # http://localhost:3000\npnpm pracht inspect";
    expect(convertShell(block, "npm")).toBe(
      "cd my-app\nnpm run deploy\nnpm run dev # http://localhost:3000\nnpx pracht inspect",
    );
    expect(convertShell(block, "yarn")).toBe(
      "cd my-app\nyarn deploy\nyarn dev # http://localhost:3000\nyarn pracht inspect",
    );
    expect(convertShell(block, "bun")).toBe(
      "cd my-app\nbun run deploy\nbun run dev # http://localhost:3000\nbunx pracht inspect",
    );
  });

  it("converts each side of &&", () => {
    expect(convertShell("pnpm install && pnpm build", "bun")).toBe("bun install && bun run build");
  });

  it("leaves repository-only and already-multi-manager blocks alone", () => {
    expect(hasPackageManagerVariants("pnpm add @pracht/image")).toBe(true);
    expect(hasPackageManagerVariants("git clone x && cd pracht\npnpm install")).toBe(false);
    expect(hasPackageManagerVariants("pnpm bench")).toBe(false);
    expect(hasPackageManagerVariants("# npm\nnpm create pracht@latest my-app\npnpm dev")).toBe(
      false,
    );
    expect(hasPackageManagerVariants("npx wrangler deploy")).toBe(false);
  });
});
