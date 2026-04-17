/**
 * Vite plugin that publishes an Agent Skills Discovery index
 * (https://github.com/cloudflare/agent-skills-discovery-rfc).
 *
 * The SKILL.md sources live under the docs example's public folder
 * (so Vite serves them as ordinary static assets in dev and copies them
 * to `dist/client/` during build). This plugin only needs to compute
 * SHA-256 digests and emit the discovery manifest at
 * `/.well-known/agent-skills/index.json`.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "vite";

export interface AgentSkillsPluginOptions {
  // Directory containing one folder per skill (each with a SKILL.md). Should
  // be inside the Vite public folder so SKILL.md files are served as static assets.
  skillsDir: string;
  // Site origin without trailing slash, e.g. https://pracht.dev
  origin: string;
  // Public URL prefix where the SKILL.md files are exposed. Defaults to `/skills`.
  publicPrefix?: string;
  // Schema URL referenced by the manifest.
  schemaUrl?: string;
}

interface SkillEntry {
  name: string;
  description: string;
  source: string;
}

const DEFAULT_SCHEMA = "https://agentskills.io/schema/v0.2.0/index.json";
const INDEX_PATH = ".well-known/agent-skills/index.json";

function readSkills(dir: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return entries;
  }
  for (const name of names) {
    const skillFile = join(dir, name, "SKILL.md");
    let stat;
    try {
      stat = statSync(skillFile);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const source = readFileSync(skillFile, "utf-8");
    const description = parseDescription(source) ?? `Pracht ${name} skill`;
    entries.push({ name, description, source });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function parseDescription(source: string): string | undefined {
  const fmMatch = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;
  const lines = fmMatch[1].split(/\r?\n/);
  let inDesc = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (!inDesc) {
      const start = line.match(/^description:\s*(.*)$/);
      if (!start) continue;
      const rest = start[1].trim();
      if (rest === "|" || rest === ">" || rest === "") {
        inDesc = true;
        continue;
      }
      return rest.replace(/^["']|["']$/g, "");
    }
    if (/^\S/.test(line)) break;
    collected.push(line.trim());
  }
  return collected.join(" ").trim() || undefined;
}

function buildIndex(
  origin: string,
  schemaUrl: string,
  publicPrefix: string,
  skills: SkillEntry[],
): string {
  const items = skills.map((skill) => ({
    name: skill.name,
    type: "claude-skill",
    description: skill.description,
    url: `${origin}/${publicPrefix}/${skill.name}/SKILL.md`,
    sha256: createHash("sha256").update(skill.source).digest("hex"),
  }));
  return JSON.stringify({ $schema: schemaUrl, skills: items }, null, 2) + "\n";
}

function normalizePrefix(value: string | undefined): string {
  const raw = (value ?? "/skills").replace(/^\/+|\/+$/g, "");
  return raw || "skills";
}

export function agentSkills(options: AgentSkillsPluginOptions): Plugin {
  const origin = options.origin.replace(/\/$/, "");
  const schemaUrl = options.schemaUrl ?? DEFAULT_SCHEMA;
  const publicPrefix = normalizePrefix(options.publicPrefix);
  const generate = () => buildIndex(origin, schemaUrl, publicPrefix, readSkills(options.skillsDir));

  return {
    name: "pracht-agent-skills",
    apply(_config, env) {
      return env.command === "serve" || (env.command === "build" && !env.isSsrBuild);
    },
    configureServer(server) {
      server.middlewares.use(`/${INDEX_PATH}`, (_req, res) => {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(generate());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: INDEX_PATH, source: generate() });
    },
  };
}
