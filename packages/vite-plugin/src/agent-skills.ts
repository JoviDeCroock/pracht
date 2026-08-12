import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { load as parseYaml } from "js-yaml";

import type { AgentSkillsConfig } from "@pracht/core";

export const AGENT_SKILLS_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
export const AGENT_SKILLS_INDEX_OUTPUT_PATH = ".well-known/agent-skills/index.json";
export const AGENT_SKILLS_OUTPUT_PREFIX = "skills";

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface AgentSkillArtifact {
  /** Output path relative to dist/client, without a leading slash. */
  outputPath: string;
  content: string;
  contentType: "application/json; charset=utf-8" | "text/markdown; charset=utf-8";
}

interface AgentSkillSource {
  name: string;
  description: string;
  source: string;
}

/**
 * Read and validate one-directory-per-skill sources, then produce the files
 * that `pracht build` writes into dist/client and `pracht dev` serves live.
 */
export function generateAgentSkillArtifacts(
  root: string,
  config: AgentSkillsConfig,
): AgentSkillArtifact[] {
  const directory = resolve(root, config.directory);
  let entries: Array<{
    name: string;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    throw new Error(
      `[pracht] Could not read agents.skills.directory ${JSON.stringify(config.directory)} ` +
        `(resolved to ${JSON.stringify(directory)}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const skills: AgentSkillSource[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillPath = resolve(directory, entry.name, "SKILL.md");
    let source: string;
    try {
      if (!statSync(skillPath).isFile()) continue;
      source = readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }

    const supportingEntries = readdirSync(resolve(directory, entry.name), {
      withFileTypes: true,
      encoding: "utf8",
    })
      .map((candidate) => candidate.name)
      .filter((name) => name !== "SKILL.md")
      .sort();
    if (supportingEntries.length > 0) {
      throw new Error(
        `[pracht] Skill ${JSON.stringify(entry.name)} contains supporting resources ` +
          `(${supportingEntries.map((name) => JSON.stringify(name)).join(", ")}). ` +
          "Built-in publishing currently supports single-file SKILL.md skills only.",
      );
    }

    const { name, description } = readFrontmatter(source, skillPath);
    if (name !== entry.name) {
      throw new Error(
        `[pracht] Skill name ${JSON.stringify(name)} in ${skillPath} must match its parent ` +
          `directory ${JSON.stringify(entry.name)}.`,
      );
    }
    if (name.length > 64 || !SKILL_NAME_RE.test(name)) {
      throw new Error(
        `[pracht] Skill name ${JSON.stringify(name)} must be 1-64 lowercase letters, numbers, ` +
          "or single hyphens, with no leading or trailing hyphen.",
      );
    }
    if (description.length > 1024) {
      throw new Error(
        `[pracht] Skill ${JSON.stringify(name)} has a description over 1024 characters.`,
      );
    }
    skills.push({ description, name, source });
  }

  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (skills.length === 0) {
    throw new Error(
      `[pracht] agents.skills.directory ${JSON.stringify(config.directory)} contains no ` +
        "<name>/SKILL.md files.",
    );
  }

  const artifacts: AgentSkillArtifact[] = skills.map((skill) => ({
    outputPath: `${AGENT_SKILLS_OUTPUT_PREFIX}/${skill.name}/SKILL.md`,
    content: skill.source,
    contentType: "text/markdown; charset=utf-8",
  }));
  const index = {
    $schema: AGENT_SKILLS_SCHEMA,
    name: config.manifest.name,
    ...(config.manifest.homepage ? { homepage: config.manifest.homepage } : {}),
    skills: skills.map((skill) => ({
      name: skill.name,
      type: "skill-md",
      description: skill.description,
      url: `/${AGENT_SKILLS_OUTPUT_PREFIX}/${skill.name}/SKILL.md`,
      digest: `sha256:${createHash("sha256").update(skill.source).digest("hex")}`,
    })),
  };
  artifacts.push({
    outputPath: AGENT_SKILLS_INDEX_OUTPUT_PATH,
    content: `${JSON.stringify(index, null, 2)}\n`,
    contentType: "application/json; charset=utf-8",
  });
  return artifacts;
}

function readFrontmatter(source: string, skillPath: string): { name: string; description: string } {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) {
    throw invalidFrontmatterError(skillPath);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatter);
  } catch (error) {
    throw new Error(
      `[pracht] ${skillPath} has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidFrontmatterError(skillPath);
  }
  const { name, description } = parsed as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    typeof description !== "string" ||
    description.trim().length === 0
  ) {
    throw invalidFrontmatterError(skillPath);
  }

  return { name, description: description.trim() };
}

function invalidFrontmatterError(skillPath: string): Error {
  return new Error(
    `[pracht] ${skillPath} must start with YAML frontmatter containing non-empty ` +
      'string "name" and "description" fields.',
  );
}
