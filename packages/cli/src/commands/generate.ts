import { defineCommand } from "citty";

import {
  generateApi,
  generateCapability,
  generateMiddleware,
  generateRoute,
  generateShell,
  type GenerateResult,
} from "../generation/index.js";
import { readProjectConfig } from "../project.js";
import { handleCliError } from "../utils.js";

export {
  generateApi,
  generateCapability,
  generateMiddleware,
  generateRoute,
  generateShell,
} from "../generation/index.js";
export type { ApiArgs, CapabilityArgs, GenerateResult, RouteArgs } from "../generation/index.js";

const routeCommand = defineCommand({
  meta: {
    name: "route",
    description: "Scaffold a route module",
  },
  args: {
    path: { type: "string", required: true, description: "Route path (e.g. /dashboard)" },
    render: { type: "string", description: "Render mode: ssr, spa, ssg, or isg" },
    shell: { type: "string", description: "Shell name" },
    middleware: { type: "string", description: "Middleware names (comma-separated)" },
    loader: { type: "boolean", description: "Include loader" },
    "error-boundary": { type: "boolean", description: "Include error boundary" },
    "static-paths": { type: "boolean", description: "Include static paths" },
    title: { type: "string", description: "Page title" },
    revalidate: { type: "string", description: "ISG revalidation seconds" },
    test: {
      type: "boolean",
      description:
        "Emit a Playwright smoke test in e2e/ (default: on when the app has a Playwright setup; --no-test to skip)",
    },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(generateRoute(args, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});

const shellCommand = defineCommand({
  meta: {
    name: "shell",
    description: "Scaffold a shell component",
  },
  args: {
    name: { type: "string", required: true, description: "Shell name" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(generateShell(args.name, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});

const middlewareCommand = defineCommand({
  meta: {
    name: "middleware",
    description: "Scaffold a middleware function",
  },
  args: {
    name: { type: "string", required: true, description: "Middleware name" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(generateMiddleware(args.name, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});

const capabilityCommand = defineCommand({
  meta: {
    name: "capability",
    description: "Scaffold a capability module",
  },
  args: {
    name: {
      type: "string",
      required: true,
      description: "Dot-separated capability name, e.g. notes.search",
    },
    effect: {
      type: "string",
      description: "Effect class: read, write, or destructive (defaults to read)",
    },
    expose: {
      type: "string",
      description:
        "Transports to expose, comma-separated: http, webmcp, mcp. Omit to keep it private.",
    },
    title: { type: "string", description: "Human-readable title" },
    description: { type: "string", description: "Contract description (required when exposed)" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(generateCapability(args, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});

const apiCommand = defineCommand({
  meta: {
    name: "api",
    description: "Scaffold an API route",
  },
  args: {
    path: { type: "string", required: true, description: "API endpoint path" },
    methods: { type: "string", description: "HTTP methods (comma-separated, e.g. GET,POST)" },
    json: { type: "boolean", description: "Output as JSON" },
  },
  async run({ args }) {
    try {
      const project = readProjectConfig(process.cwd());
      outputResult(generateApi(args, project), Boolean(args.json));
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});

export default defineCommand({
  meta: {
    name: "generate",
    description: "Scaffold framework files",
  },
  subCommands: {
    route: routeCommand,
    shell: shellCommand,
    middleware: middlewareCommand,
    api: apiCommand,
    capability: capabilityCommand,
  },
});

function outputResult(result: GenerateResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }

  console.log(`Created ${result.kind}:`);
  for (const file of result.created) {
    console.log(`  ${file}`);
  }
  for (const file of result.updated) {
    console.log(`  updated ${file}`);
  }
  for (const note of result.notes ?? []) {
    console.log("");
    console.log(note);
  }
}
