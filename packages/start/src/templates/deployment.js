import { WRANGLER_COMPATIBILITY_DATE } from "../config.js";

export function createWranglerConfig(projectName) {
  const compatibilityDate = WRANGLER_COMPATIBILITY_DATE;

  return [
    "{",
    '  "$schema": "node_modules/wrangler/config-schema.json",',
    `  "name": ${JSON.stringify(projectName)},`,
    // `pracht build` writes this thin wrapper next to server.js. It re-exports
    // only the default handler and any Worker entrypoint classes: workerd
    // validates every named export of the deployed entry module and rejects the
    // build metadata (buildTarget, manifests, ...) server.js also exports.
    '  "main": "dist/server/worker.js",',
    `  "compatibility_date": ${JSON.stringify(compatibilityDate)},`,
    '  "assets": {',
    '    "binding": "ASSETS",',
    '    "directory": "dist/client",',
    // The assets binding defaults to redirecting a prerendered route to its
    // trailing-slash form, so `GET /about` would answer 307 on Cloudflare
    // where Node and Vercel answer 200 — for the same app, and for every URL
    // the generated llms.txt advertises. Drop the slash instead so one
    // canonical form works across adapters.
    '    "html_handling": "drop-trailing-slash",',
    '    "run_worker_first": true',
    "  }",
    "}",
    "",
  ].join("\n");
}

export function createNetlifyConfig(packageManager) {
  const buildCommand =
    packageManager === "npm" || packageManager === "bun"
      ? `${packageManager} run build`
      : `${packageManager} build`;

  return [
    "[build]",
    `  command = ${JSON.stringify(buildCommand)}`,
    '  publish = "dist/client"',
    "",
    "[functions]",
    '  directory = "netlify/functions"',
    "",
  ].join("\n");
}

export function createCloudflareEnvDeclaration() {
  return [
    'import "@pracht/core";',
    'declare module "@pracht/core" {',
    "  interface Register {",
    "    context: {",
    "      env: Env;",
    "      executionContext: ExecutionContext;",
    "    };",
    "  }",
    "}",
    "",
  ].join("\n");
}

export function createDockerfile(packageManager) {
  const COMMANDS = {
    npm: {
      build: "npm run build",
      install: "npm install",
      lockfile: "package-lock.json*",
      prune: "npm prune --omit=dev",
      setup: null,
    },
    pnpm: {
      build: "pnpm build",
      install: "pnpm install",
      lockfile: "pnpm-lock.yaml*",
      prune: "pnpm prune --prod",
      setup: "corepack enable pnpm",
    },
    yarn: {
      build: "yarn build",
      install: "yarn install",
      lockfile: "yarn.lock*",
      prune: "yarn install --production --ignore-scripts --prefer-offline",
      setup: "corepack enable yarn",
    },
  };

  // The runtime image ships Node.js, so bun scaffolds fall back to npm inside Docker.
  const commands = COMMANDS[packageManager] ?? COMMANDS.npm;

  const lines = ["# syntax=docker/dockerfile:1", "", "FROM node:22-alpine AS base", "WORKDIR /app"];

  if (commands.setup) {
    lines.push(`RUN ${commands.setup}`);
  }

  lines.push(
    "",
    "FROM base AS deps",
    `COPY package.json ${commands.lockfile} ./`,
    `RUN ${commands.install}`,
    "",
    "FROM deps AS build",
    "COPY . .",
    `RUN ${commands.build}`,
    `RUN ${commands.prune}`,
    "",
    "FROM node:22-alpine AS runtime",
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "ENV PORT=3000",
    "COPY --from=build /app/package.json ./package.json",
    "COPY --from=build /app/node_modules ./node_modules",
    "COPY --from=build /app/dist ./dist",
    "EXPOSE 3000",
    'CMD ["node", "dist/server/server.js"]',
    "",
  );

  return lines.join("\n");
}

export function createDockerignore() {
  return [
    "node_modules",
    "dist",
    ".git",
    ".env*",
    "!.env.example",
    "Dockerfile",
    ".dockerignore",
    "",
  ].join("\n");
}
