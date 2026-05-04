import { existsSync } from "node:fs";
import { mkdtemp, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { ValidationError, getPackageManager, parseArgs, scaffoldProject } from "../src/index.js";

describe("create-pracht", () => {
  it("detects the package manager from the npm user agent", () => {
    expect(getPackageManager("pnpm/10.0.0 npm/? node/? darwin x64")).toBe("pnpm");
    expect(getPackageManager("yarn/4.7.0 npm/? node/? darwin x64")).toBe("yarn");
    expect(getPackageManager("bun/1.2.0 npm/? node/? darwin x64")).toBe("bun");
    expect(getPackageManager("npm/10.9.0 node/v22.0.0 darwin x64")).toBe("npm");
  });

  it("scaffolds a node starter", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-node-"));
    const targetDir = join(root, "my-node-app");

    await scaffoldProject({
      adapter: {
        description: "Node.js server with a generated server entry",
        id: "node",
        label: "Node.js",
        packageName: "@pracht/adapter-node",
        short: "node",
      },
      packageManager: "pnpm",
      targetDir,
    });

    const packageJson = await readFile(join(targetDir, "package.json"), "utf-8");
    const gitignore = await readFile(join(targetDir, ".gitignore"), "utf-8");
    const routes = await readFile(join(targetDir, "src/routes.ts"), "utf-8");

    expect(packageJson).toMatch(/"@pracht\/cli": "\^\d+\.\d+\.\d+"/);
    expect(packageJson).toMatch(/"@pracht\/adapter-node": "\^\d+\.\d+\.\d+"/);
    expect(packageJson).toContain('"start": "node dist/server/server.js"');
    expect(packageJson).not.toContain("wrangler");
    expect(gitignore).toContain(".env*");
    expect(gitignore).toContain("!.env.example");
    expect(gitignore).toContain(".dev.vars");
    expect(routes).toContain('route("/", "./routes/home.tsx"');
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(false);

    const agents = await readFile(join(targetDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("manifest routing");
    expect(agents).toContain("src/routes.ts");
    expect(agents).toContain("pracht generate route");
    expect(agents).toContain("pnpm dev");

    const claudeLink = await readlink(join(targetDir, "CLAUDE.md"));
    expect(claudeLink).toBe("AGENTS.md");

    const tsconfig = await readFile(join(targetDir, "tsconfig.json"), "utf-8");
    expect(tsconfig).toMatchInlineSnapshot(`
      "{
          "compilerOptions": {
              "allowImportingTsExtensions": true,
              "jsx": "react-jsx",
              "jsxImportSource": "preact",
              "lib": [
                  "ES2022",
                  "DOM",
                  "DOM.Iterable"
              ],
              "module": "ESNext",
              "moduleResolution": "Bundler",
              "noEmit": true,
              "skipLibCheck": true,
              "strict": true,
              "target": "ES2022",
              "types": [
                  "vite/client"
              ],
              "verbatimModuleSyntax": true
          }
      }"
    `);
  });

  it("scaffolds a cloudflare starter", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-cf-"));
    const targetDir = join(root, "my-cf-app");

    await scaffoldProject({
      adapter: {
        description: "Cloudflare Workers with wrangler deploy",
        id: "cloudflare",
        label: "Cloudflare Workers",
        packageName: "@pracht/adapter-cloudflare",
        short: "cf",
      },
      packageManager: "pnpm",
      targetDir,
    });

    const packageJson = await readFile(join(targetDir, "package.json"), "utf-8");
    const wranglerConfig = await readFile(join(targetDir, "wrangler.jsonc"), "utf-8");

    expect(packageJson).toMatch(/"@pracht\/cli": "\^\d+\.\d+\.\d+"/);
    expect(packageJson).toMatch(/"@pracht\/adapter-cloudflare": "\^\d+\.\d+\.\d+"/);

    expect(packageJson).toContain('"wrangler": "^4.81.0"');
    expect(packageJson).not.toContain('"@cloudflare/vite-plugin"');
    expect(wranglerConfig).toContain('"main": "dist/server/server.js"');
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(true);

    const tsconfig = await readFile(join(targetDir, "tsconfig.json"), "utf-8");
    expect(tsconfig).toMatchInlineSnapshot(`
      "{
          "compilerOptions": {
              "allowImportingTsExtensions": true,
              "jsx": "react-jsx",
              "jsxImportSource": "preact",
              "lib": [
                  "ES2022",
                  "DOM",
                  "DOM.Iterable"
              ],
              "module": "ESNext",
              "moduleResolution": "Bundler",
              "noEmit": true,
              "skipLibCheck": true,
              "strict": true,
              "target": "ES2022",
              "types": [
                  "vite/client"
              ],
              "verbatimModuleSyntax": true
          }
      }"
    `);

    const envDts = await readFile(join(targetDir, "src/env.d.ts"), "utf-8");
    expect(envDts).toContain("interface Register");
    expect(envDts).toContain("env: Env");

    const agents = await readFile(join(targetDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("wrangler.jsonc");
    expect(agents).toContain("Cloudflare Workers adapter");
  });

  it("scaffolds a vercel starter", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-vercel-"));
    const targetDir = join(root, "my-vercel-app");

    await scaffoldProject({
      adapter: {
        description: "Vercel Edge Functions with prebuilt deploy",
        id: "vercel",
        label: "Vercel",
        packageName: "@pracht/adapter-vercel",
        short: "vercel",
      },
      packageManager: "pnpm",
      targetDir,
    });

    const packageJson = await readFile(join(targetDir, "package.json"), "utf-8");
    const readme = await readFile(join(targetDir, "README.md"), "utf-8");

    expect(packageJson).toMatch(/"@pracht\/adapter-vercel": "\^\d+\.\d+\.\d+"/);
    expect(packageJson).toMatch(/"vercel": "\^\d+\.\d+\.\d+"/);

    expect(packageJson).toContain('"deploy": "pracht build && vercel deploy --prebuilt"');
    expect(readme).toContain("configured for Vercel");
    expect(readme).toContain("pnpm deploy");
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(false);

    const tsconfig = await readFile(join(targetDir, "tsconfig.json"), "utf-8");
    expect(tsconfig).toMatchInlineSnapshot(`
      "{
          "compilerOptions": {
              "allowImportingTsExtensions": true,
              "jsx": "react-jsx",
              "jsxImportSource": "preact",
              "lib": [
                  "ES2022",
                  "DOM",
                  "DOM.Iterable"
              ],
              "module": "ESNext",
              "moduleResolution": "Bundler",
              "noEmit": true,
              "skipLibCheck": true,
              "strict": true,
              "target": "ES2022",
              "types": [
                  "vite/client"
              ],
              "verbatimModuleSyntax": true
          }
      }"
    `);
  });

  it("scaffolds a pages-router starter", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-pages-"));
    const targetDir = join(root, "my-pages-app");

    await scaffoldProject({
      adapter: {
        description: "Node.js server with a generated server entry",
        id: "node",
        label: "Node.js",
        packageName: "@pracht/adapter-node",
        short: "node",
      },
      packageManager: "pnpm",
      router: "pages",
      targetDir,
    });

    const viteConfig = await readFile(join(targetDir, "vite.config.ts"), "utf-8");
    const readme = await readFile(join(targetDir, "README.md"), "utf-8");

    expect(viteConfig).toContain('pagesDir: "/src/pages"');
    expect(existsSync(join(targetDir, "src/pages/index.tsx"))).toBe(true);
    expect(existsSync(join(targetDir, "src/pages/_app.tsx"))).toBe(true);
    expect(existsSync(join(targetDir, "src/routes.ts"))).toBe(false);
    expect(readme).toContain("src/pages/");

    const agents = await readFile(join(targetDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("pages routing");
    expect(agents).toContain("src/pages/");
  });

  it("parseArgs handles --yes flag", () => {
    const opts = parseArgs(["my-app", "--yes", "--skip-install"]);
    expect(opts.yes).toBe(true);
    expect(opts.dir).toBe("my-app");
    expect(opts.skipInstall).toBe(true);
  });

  it("parseArgs handles -y shorthand", () => {
    const opts = parseArgs(["-y"]);
    expect(opts.yes).toBe(true);
  });

  it("parseArgs handles --json flag", () => {
    const opts = parseArgs(["my-app", "--json", "--yes"]);
    expect(opts.json).toBe(true);
  });

  it("parseArgs handles --dry-run flag", () => {
    const opts = parseArgs(["my-app", "--dry-run"]);
    expect(opts.dryRun).toBe(true);
  });

  it("parseArgs throws ValidationError for invalid adapter", () => {
    expect(() => parseArgs(["--adapter=invalid"])).toThrow(ValidationError);
    expect(() => parseArgs(["--adapter=invalid"])).toThrow(/Invalid adapter/);
  });

  it("parseArgs throws ValidationError for invalid router", () => {
    expect(() => parseArgs(["--router=invalid"])).toThrow(ValidationError);
    expect(() => parseArgs(["--router=invalid"])).toThrow(/Invalid router/);
  });

  it("ValidationError has code 2", () => {
    const err = new ValidationError("test");
    expect(err.code).toBe(2);
    expect(err.message).toBe("test");
    expect(err).toBeInstanceOf(Error);
  });
});
