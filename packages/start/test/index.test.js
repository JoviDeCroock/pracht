import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  ValidationError,
  getPackageManager,
  initGitRepository,
  parseArgs,
  run,
  scaffoldProject,
} from "../src/index.js";

const NODE_ADAPTER = {
  description: "Node.js server with a generated server entry",
  id: "node",
  label: "Node.js",
  packageName: "@pracht/adapter-node",
  short: "node",
};

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
    expect(packageJson).toContain('"preview": "pracht preview"');
    expect(packageJson).toContain('"start": "node dist/server/server.js"');
    expect(packageJson).not.toContain("wrangler");
    expect(gitignore).toContain(".env*");
    expect(gitignore).toContain("!.env.example");
    expect(gitignore).toContain(".dev.vars");
    expect(gitignore).not.toContain("\n.pracht\n");
    expect(gitignore).toContain("Keep .pracht/app-graph.json committed");
    expect(routes).toContain('route("/", "./routes/home.tsx"');
    expect(routes).toContain("// constraints: [");
    expect(routes).toContain('//   requireHead("**"),');
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(false);

    const dockerfile = await readFile(join(targetDir, "Dockerfile"), "utf-8");
    const dockerignore = await readFile(join(targetDir, ".dockerignore"), "utf-8");
    const readme = await readFile(join(targetDir, "README.md"), "utf-8");
    expect(dockerfile).toContain("FROM node:22-alpine AS base");
    expect(dockerfile).toContain("corepack enable pnpm");
    expect(dockerfile).toContain("RUN pnpm install");
    expect(dockerfile).toContain("RUN pnpm build");
    expect(dockerfile).toContain('CMD ["node", "dist/server/server.js"]');
    expect(dockerignore).toContain("node_modules");
    expect(dockerignore).toContain(".env*");
    expect(readme).toContain("docker build");
    expect(readme).toContain("`pracht verify` validates routes and constraints.");
    expect(readme).toContain("`pracht plan --write`");
    expect(readme).toContain("`pracht report`");

    const viteConfig = await readFile(join(targetDir, "vite.config.ts"), "utf-8");
    expect(viteConfig).not.toContain("tailwindcss");
    expect(existsSync(join(targetDir, "src/styles/global.css"))).toBe(false);
    expect(packageJson).not.toContain("tailwindcss");

    const agents = await readFile(join(targetDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("manifest routing");
    expect(agents).toContain("src/routes.ts");
    expect(agents).toContain("pracht generate route");
    expect(agents).toContain("pracht verify");
    expect(agents).toContain("pracht plan --write");
    expect(agents).toContain("pracht report");
    expect(agents).toContain("pracht llms --write");
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

    expect(packageJson).toContain('"preview": "pracht preview"');
    expect(packageJson).toContain('"wrangler": "^4.81.0"');
    expect(packageJson).not.toContain('"@cloudflare/vite-plugin"');
    expect(wranglerConfig).toContain('"main": "dist/server/server.js"');
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(true);
    expect(existsSync(join(targetDir, "Dockerfile"))).toBe(false);
    expect(existsSync(join(targetDir, ".dockerignore"))).toBe(false);

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
    expect(packageJson).not.toContain('"preview"');
    expect(readme).toContain("configured for Vercel");
    expect(readme).toContain("pnpm deploy");
    expect(existsSync(join(targetDir, "wrangler.jsonc"))).toBe(false);
    expect(existsSync(join(targetDir, "Dockerfile"))).toBe(false);
    expect(existsSync(join(targetDir, ".dockerignore"))).toBe(false);

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

  it("scaffolds a tailwind starter with the manifest router", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-tailwind-"));
    const targetDir = join(root, "my-tailwind-app");

    await scaffoldProject({
      adapter: NODE_ADAPTER,
      packageManager: "pnpm",
      tailwind: true,
      targetDir,
    });

    const packageJson = await readFile(join(targetDir, "package.json"), "utf-8");
    const viteConfig = await readFile(join(targetDir, "vite.config.ts"), "utf-8");
    const globalCss = await readFile(join(targetDir, "src/styles/global.css"), "utf-8");
    const shell = await readFile(join(targetDir, "src/shells/public.tsx"), "utf-8");
    const readme = await readFile(join(targetDir, "README.md"), "utf-8");

    expect(packageJson).toMatch(/"tailwindcss": "\^\d+\.\d+\.\d+"/);
    expect(packageJson).toMatch(/"@tailwindcss\/vite": "\^\d+\.\d+\.\d+"/);
    expect(viteConfig).toContain('import tailwindcss from "@tailwindcss/vite";');
    expect(viteConfig).toContain("plugins: [pracht({ adapter: nodeAdapter() }), tailwindcss()]");
    expect(globalCss).toBe('@import "tailwindcss";\n');
    expect(shell).toContain('import "../styles/global.css";');
    expect(readme).toContain("src/styles/global.css");

    const agents = await readFile(join(targetDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("src/styles/global.css");
  });

  it("scaffolds a tailwind starter with the pages router", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-tailwind-pages-"));
    const targetDir = join(root, "my-tailwind-pages-app");

    await scaffoldProject({
      adapter: NODE_ADAPTER,
      packageManager: "pnpm",
      router: "pages",
      tailwind: true,
      targetDir,
    });

    const viteConfig = await readFile(join(targetDir, "vite.config.ts"), "utf-8");
    const app = await readFile(join(targetDir, "src/pages/_app.tsx"), "utf-8");

    expect(viteConfig).toContain(
      'plugins: [pracht({ pagesDir: "/src/pages", adapter: nodeAdapter() }), tailwindcss()]',
    );
    expect(app).toContain('import "../styles/global.css";');
    expect(existsSync(join(targetDir, "src/styles/global.css"))).toBe(true);
  });

  it("run --dry-run --json lists tailwind and docker files without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-dry-run-"));
    const targetDir = join(root, "my-dry-run-app");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    let output;
    try {
      await run([
        targetDir,
        "--adapter=node",
        "--router=manifest",
        "--template=tailwind",
        "--agent-tools",
        "--dry-run",
        "--json",
      ]);
      output = JSON.parse(logSpy.mock.calls.at(-1)[0]);
    } finally {
      logSpy.mockRestore();
    }

    expect(output.dryRun).toBe(true);
    expect(output.tailwind).toBe(true);
    expect(output.agentTools).toBe(true);
    expect(output.files).toContain("Dockerfile");
    expect(output.files).toContain(".dockerignore");
    expect(output.files).toContain("src/styles/global.css");
    expect(output.files).toContain(".gitignore");
    expect(output.files).toContain(".mcp.json");
    expect(output.files).toContain(".claude/skills/add-auth/SKILL.md");
    expect(existsSync(targetDir)).toBe(false);
  });

  it("run --dry-run --json omits tailwind files for the minimal template", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-dry-run-minimal-"));
    const targetDir = join(root, "my-minimal-app");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    let output;
    try {
      await run([
        targetDir,
        "--adapter=vercel",
        "--router=manifest",
        "--template=minimal",
        "--no-agent-tools",
        "--dry-run",
        "--json",
      ]);
      output = JSON.parse(logSpy.mock.calls.at(-1)[0]);
    } finally {
      logSpy.mockRestore();
    }

    expect(output.tailwind).toBe(false);
    expect(output.agentTools).toBe(false);
    expect(output.files).not.toContain("Dockerfile");
    expect(output.files).not.toContain("src/styles/global.css");
    expect(output.files).not.toContain(".mcp.json");
    expect(output.files.some((file) => file.startsWith(".claude/skills/"))).toBe(false);
    expect(existsSync(targetDir)).toBe(false);
  });

  it("seeds Claude Code skills and an MCP config by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-agent-tools-"));
    const targetDir = join(root, "my-agent-app");

    await scaffoldProject({
      adapter: NODE_ADAPTER,
      packageManager: "pnpm",
      targetDir,
    });

    const mcpConfig = JSON.parse(await readFile(join(targetDir, ".mcp.json"), "utf-8"));
    expect(mcpConfig.mcpServers.pracht).toEqual({
      command: "npx",
      args: ["pracht", "mcp"],
    });

    const skillFile = join(targetDir, ".claude/skills/add-auth/SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(await readFile(skillFile, "utf-8")).toContain("name: add-auth");

    const agents = await readFile(join(targetDir, "AGENTS.md"), "utf-8");
    expect(agents).toContain("## Agent tooling");
    expect(agents).toContain(".claude/skills/");
    expect(agents).toContain(".mcp.json");
  });

  it("skips agent tooling when agentTools is false", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-no-agent-tools-"));
    const targetDir = join(root, "my-plain-app");

    await scaffoldProject({
      adapter: NODE_ADAPTER,
      agentTools: false,
      packageManager: "pnpm",
      targetDir,
    });

    expect(existsSync(join(targetDir, ".mcp.json"))).toBe(false);
    expect(existsSync(join(targetDir, ".claude"))).toBe(false);

    const agents = await readFile(join(targetDir, "AGENTS.md"), "utf-8");
    expect(agents).not.toContain("## Agent tooling");
  });

  it("initializes a git repository with an initial commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-git-"));
    const targetDir = join(root, "my-git-app");

    await scaffoldProject({
      adapter: NODE_ADAPTER,
      packageManager: "pnpm",
      targetDir,
    });

    const result = await initGitRepository(targetDir);

    expect(result.initialized).toBe(true);
    expect(existsSync(join(targetDir, ".git"))).toBe(true);

    const subject = execFileSync("git", ["-C", targetDir, "log", "-1", "--format=%s"], {
      encoding: "utf-8",
    }).trim();
    expect(subject).toBe("Initial commit from create-pracht");

    const status = execFileSync("git", ["-C", targetDir, "status", "--porcelain"], {
      encoding: "utf-8",
    }).trim();
    expect(status).toBe("");
  });

  it("skips git init inside an existing repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "pracht-start-git-skip-"));
    execFileSync("git", ["-C", root, "init"], { encoding: "utf-8" });

    const targetDir = join(root, "my-nested-app");
    await scaffoldProject({
      adapter: NODE_ADAPTER,
      packageManager: "pnpm",
      targetDir,
    });

    const result = await initGitRepository(targetDir);

    expect(result.initialized).toBe(false);
    expect(result.reason).toBe("existing-repo");
    expect(existsSync(join(targetDir, ".git"))).toBe(false);
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

  it("parseArgs handles --tailwind and --no-tailwind flags", () => {
    expect(parseArgs([]).tailwind).toBeUndefined();
    expect(parseArgs(["--tailwind"]).tailwind).toBe(true);
    expect(parseArgs(["--no-tailwind"]).tailwind).toBe(false);
  });

  it("parseArgs handles --template flag", () => {
    expect(parseArgs(["--template=minimal"]).tailwind).toBe(false);
    expect(parseArgs(["--template=tailwind"]).tailwind).toBe(true);
  });

  it("parseArgs lets an explicit tailwind flag override --template", () => {
    expect(parseArgs(["--template=tailwind", "--no-tailwind"]).tailwind).toBe(false);
    expect(parseArgs(["--template=minimal", "--tailwind"]).tailwind).toBe(true);
  });

  it("parseArgs throws ValidationError for invalid template", () => {
    expect(() => parseArgs(["--template=invalid"])).toThrow(ValidationError);
    expect(() => parseArgs(["--template=invalid"])).toThrow(/Invalid template/);
  });

  it("parseArgs handles --agent-tools and --no-agent-tools flags", () => {
    expect(parseArgs([]).agentTools).toBeUndefined();
    expect(parseArgs(["--agent-tools"]).agentTools).toBe(true);
    expect(parseArgs(["--no-agent-tools"]).agentTools).toBe(false);
  });

  it("parseArgs handles --no-git flag", () => {
    expect(parseArgs([]).git).toBe(true);
    expect(parseArgs(["--no-git"]).git).toBe(false);
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
