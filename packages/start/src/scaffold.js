import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { buildAgentToolFiles } from "./agent-tools.js";
import { DEFAULT_DIRECTORY } from "./config.js";
import { resolvePackageVersions } from "./package-versions.js";
import {
  createBaseTSConfig,
  createHealthRoute,
  createHomeRoute,
  createNotFoundRoute,
  createPagesHomeRoute,
  createRoutesFile,
  createShellFile,
  createViteConfig,
} from "./templates/application.js";
import {
  createCloudflareEnvDeclaration,
  createDockerfile,
  createDockerignore,
  createNetlifyConfig,
  createWranglerConfig,
} from "./templates/deployment.js";
import { createAgentInstructions, createReadme } from "./templates/documentation.js";
import { createPackageJson } from "./templates/project.js";
import {
  createPnpmWorkspaceConfig,
  findAncestorPnpmWorkspace,
  pnpmBuildAllowlist,
  pnpmBuildPolicyName,
} from "./workspace-policy.js";

export async function scaffoldProject({
  adapter,
  agentTools = true,
  packageManager,
  pnpmMajor = 11,
  resolveRemoteVersions = true,
  router = "manifest",
  tailwind = false,
  targetDir,
}) {
  const packageName = toPackageName(basename(targetDir));
  const { files, pnpmWorkspaceNotice } = await buildProjectFiles({
    adapter,
    agentTools,
    packageManager,
    pnpmMajor,
    projectName: packageName,
    resolveRemoteVersions,
    router,
    tailwind,
    targetDir,
  });

  await mkdir(targetDir, { recursive: true });

  // pnpm resolves build-script policy from the workspace root, so inside an existing
  // monorepo our own file would be read by nobody — and `pnpm install` run from
  // the app directory would find it first and re-root the workspace there,
  // detaching the app from its siblings. Tell the user what to add instead.
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = resolve(targetDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  // AGENTS.md (and the CLAUDE.md alias pointing at it) are agent tooling too —
  // `--no-agent-tools` means a project with none of it, not "all of it except
  // the instruction files". README.md carries the same commands for humans.
  if (!agentTools) return { pnpmWorkspaceNotice };

  try {
    await symlink("AGENTS.md", resolve(targetDir, "CLAUDE.md"));
  } catch (error) {
    if (error && typeof error === "object" && ["EPERM", "EINVAL"].includes(error.code)) {
      await copyFile(resolve(targetDir, "AGENTS.md"), resolve(targetDir, "CLAUDE.md"));
    } else {
      throw error;
    }
  }

  return { pnpmWorkspaceNotice };
}

export async function buildProjectFiles({
  adapter,
  agentTools = true,
  packageManager,
  pnpmMajor = 11,
  projectName,
  resolveRemoteVersions = true,
  router,
  tailwind = false,
  targetDir,
}) {
  const packagesToResolve = [
    "@pracht/cli",
    "@pracht/vite-plugin",
    "@pracht/core",
    adapter.packageName,
    "typescript",
  ];
  if (adapter.id === "vercel") {
    packagesToResolve.push("vercel");
  }
  if (adapter.id === "netlify") {
    packagesToResolve.push("netlify-cli");
  }
  if (tailwind) {
    packagesToResolve.push("tailwindcss", "@tailwindcss/vite");
  }

  const versions = await resolvePackageVersions(packagesToResolve, {
    remote: resolveRemoteVersions,
  });
  const policyMajor = pnpmMajor ?? 11;
  const ancestorWorkspace = targetDir ? findAncestorPnpmWorkspace(targetDir) : null;
  const pnpmWorkspaceNotice = ancestorWorkspace
    ? {
        packages: pnpmBuildAllowlist(adapter, tailwind),
        policy: pnpmBuildPolicyName(policyMajor),
        root: ancestorWorkspace,
      }
    : null;

  const files = {
    ".gitignore":
      "dist\nnode_modules\n.netlify\n.wrangler\n.vercel\n.env*\n!.env.example\n.dev.vars\n# Keep .pracht/app-graph.json committed — it is the `pracht plan` snapshot.\n",
    "README.md": createReadme({
      adapter,
      agentTools,
      packageManager,
      pnpmMajor,
      pnpmWorkspaceNotice,
      projectName,
      router,
      tailwind,
    }),
    "package.json": createPackageJson({
      adapter,
      projectName,
      tailwind,
      versions,
    }),
    "src/api/health.ts": createHealthRoute(adapter),
    "vite.config.ts": createViteConfig(adapter, router, tailwind),
    "tsconfig.json": createBaseTSConfig(adapter),
  };

  if (agentTools) {
    files["AGENTS.md"] = createAgentInstructions({
      adapter,
      agentTools,
      packageManager,
      router,
      tailwind,
    });
  }

  if (router === "pages") {
    files["src/pages/_app.tsx"] = createShellFile(projectName, tailwind);
    files["src/pages/index.tsx"] = createPagesHomeRoute(adapter);
    files["src/pages/404.tsx"] = createNotFoundRoute();
  } else {
    files["src/routes.ts"] = createRoutesFile();
    files["src/routes/home.tsx"] = createHomeRoute(adapter);
    files["src/routes/not-found.tsx"] = createNotFoundRoute();
    files["src/shells/public.tsx"] = createShellFile(projectName, tailwind);
  }

  if (tailwind) {
    files["src/styles/global.css"] = '@import "tailwindcss";\n';
  }

  if (adapter.id === "cloudflare") {
    files["wrangler.jsonc"] = createWranglerConfig(projectName);
    files["src/env.d.ts"] = createCloudflareEnvDeclaration();
  }

  if (adapter.id === "netlify") {
    files["netlify.toml"] = createNetlifyConfig(packageManager);
  }

  if (adapter.id === "node") {
    files["Dockerfile"] = createDockerfile(packageManager);
    files[".dockerignore"] = createDockerignore();
  }

  if (agentTools) {
    Object.assign(files, await buildAgentToolFiles());
  }

  // pnpm resolves build-script policy from the workspace root, so inside an existing
  // workspace our own file would be read by nobody — and `pnpm install` run
  // from the app directory would find it first and re-root the workspace there,
  // detaching the app from its siblings. Decided here so the `--json` and
  // `--dry-run` listings match what is actually written.
  if (!pnpmWorkspaceNotice) {
    files["pnpm-workspace.yaml"] = createPnpmWorkspaceConfig(adapter, tailwind, policyMajor);
  }

  return { files, pnpmWorkspaceNotice };
}

export function toPackageName(value) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || DEFAULT_DIRECTORY;
}
