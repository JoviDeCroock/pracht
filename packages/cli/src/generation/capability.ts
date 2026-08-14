import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { toManifestModulePath, upsertObjectEntry } from "../manifest.js";
import {
  assertFileExists,
  displayPath,
  resolveProjectPath,
  resolveScopedFile,
  writeGeneratedFile,
  type ProjectConfig,
} from "../project.js";
import { ensureTrailingNewline, parseCommaList, quote, requireEnum } from "../utils.js";
import { titleFromPath } from "./paths.js";
import { buildCapabilityModuleSource } from "./capability-source.js";
import type { GenerateResult } from "./types.js";

export interface CapabilityArgs {
  description?: string;
  effect?: string;
  expose?: string;
  name: string;
  title?: string;
}

const CAPABILITY_NAME_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const CAPABILITY_TRANSPORTS = ["http", "webmcp", "mcp"];

export function generateCapability(args: CapabilityArgs, project: ProjectConfig): GenerateResult {
  if (project.mode === "pages") {
    throw new Error(
      "Pages router apps have no manifest to register capabilities in. `pracht generate capability` is only available for manifest apps.",
    );
  }

  const name = args.name;
  if (!CAPABILITY_NAME_RE.test(name)) {
    throw new Error(
      `Invalid capability name ${quote(name)}. Names are dot-separated segments of letters, numbers, hyphens, and underscores — e.g. "notes.search".`,
    );
  }

  const effect = requireEnum(args.effect, "effect", ["read", "write", "destructive"], "read") as
    | "read"
    | "write"
    | "destructive";
  const expose = parseCommaList(args.expose);
  for (const transport of expose) {
    if (!CAPABILITY_TRANSPORTS.includes(transport)) {
      throw new Error(
        `Unknown transport ${quote(transport)} in --expose. Expected one of ${CAPABILITY_TRANSPORTS.join(", ")}.`,
      );
    }
  }

  // The runtime, `defineCapability()`, and `pracht verify` all reject this;
  // refusing here means the scaffold never writes a module that cannot build.
  if (effect === "destructive" && expose.some((transport) => transport !== "http")) {
    throw new Error(
      "A destructive capability may only be exposed over http — agent hosts cannot be trusted to carry the prepare/commit confirmation flow. Drop webmcp/mcp from --expose.",
    );
  }
  if (expose.includes("webmcp") && !expose.includes("http")) {
    throw new Error("`--expose webmcp` requires http: the page tool calls the HTTP projection.");
  }

  // An exposed capability needs a real description because it is what an
  // agent reads to decide whether to call the tool. Do not generate a
  // placeholder that technically satisfies verification but conveys nothing.
  if (expose.length > 0 && !args.description) {
    throw new Error(
      "`--description` is required when --expose is set: it is the contract text agents read, and `pracht verify` fails without one.",
    );
  }

  const manifestPath = resolveProjectPath(project.root, project.appFile);
  assertFileExists(manifestPath, `App manifest not found at ${project.appFile}.`);

  const capabilityFile = resolveScopedFile(
    project.root,
    project.capabilitiesDir,
    `${name.replaceAll(".", "-")}.ts`,
  );
  writeGeneratedFile(
    capabilityFile,
    buildCapabilityModuleSource({
      description: args.description ?? `TODO: describe what ${name} does.`,
      effect,
      expose,
      title: args.title ?? titleFromPath(`/${name.replaceAll(".", " ")}`),
    }),
  );

  const manifestSource = readFileSync(manifestPath, "utf-8");
  const updatedSource = upsertObjectEntry(
    manifestSource,
    "capabilities",
    `${quote(name)}: ${quote(toManifestModulePath(manifestPath, capabilityFile))}`,
  );
  writeFileSync(manifestPath, ensureTrailingNewline(updatedSource), "utf-8");

  return {
    created: [displayPath(project.root, capabilityFile)],
    kind: "capability",
    // The generated module imports a separate package. Surface the missing
    // dependency now instead of letting the app fail later at request time.
    ...(hasCapabilitiesDependency(project.root)
      ? {}
      : {
          notes: [
            "This module imports `@pracht/capabilities`, which is not installed yet. Run: npm install @pracht/capabilities",
          ],
        }),
    updated: [displayPath(project.root, manifestPath)],
  };
}

function hasCapabilitiesDependency(root: string): boolean {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
    return Boolean(
      packageJson.dependencies?.["@pracht/capabilities"] ??
      packageJson.devDependencies?.["@pracht/capabilities"],
    );
  } catch {
    return true; // Unreadable package.json — do not invent advice.
  }
}
