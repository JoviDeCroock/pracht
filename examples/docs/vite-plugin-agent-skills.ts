/**
 * Vite plugin that publishes an Agent Skills Discovery index
 * (https://github.com/cloudflare/agent-skills-discovery-rfc).
 *
 * The SKILL.md sources live in the workspace `skills/` directory. The plugin
 * mirrors them into the Vite publicDir under `<publicPrefix>/<name>/SKILL.md`
 * so the standard Vite static-asset pipeline serves them in dev and copies
 * them into `dist/client/` at build. The plugin also emits the discovery
 * manifest at `/.well-known/agent-skills/index.json`.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "vite";

export interface AgentSkillsPluginOptions {
  // Directory containing one folder per skill (each with a SKILL.md).
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

function mirrorSkillsToPublicDir(
  publicDir: string,
  publicPrefix: string,
  skills: SkillEntry[],
): void {
  const targetDir = join(publicDir, publicPrefix);
  rmSync(targetDir, { recursive: true, force: true });
  for (const skill of skills) {
    const dir = join(targetDir, skill.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skill.source);
  }
}

export function agentSkills(options: AgentSkillsPluginOptions): Plugin {
  const origin = options.origin.replace(/\/$/, "");
  const schemaUrl = options.schemaUrl ?? DEFAULT_SCHEMA;
  const publicPrefix = normalizePrefix(options.publicPrefix);
  let publicDir = "";

  const readAll = () => readSkills(options.skillsDir);
  const generate = () => buildIndex(origin, schemaUrl, publicPrefix, readAll());
  const mirror = () => {
    if (publicDir) mirrorSkillsToPublicDir(publicDir, publicPrefix, readAll());
  };

  return {
    name: "pracht-agent-skills",
    apply(_config, env) {
      return env.command === "serve" || (env.command === "build" && !env.isSsrBuild);
    },
    configResolved(config) {
      publicDir = config.publicDir;
      mirror();
    },
    configureServer(server) {
      server.middlewares.use(`/${INDEX_PATH}`, (_req, res) => {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(generate());
      });
      server.watcher.add(options.skillsDir);
      const onChange = (file: string) => {
        if (file.startsWith(options.skillsDir)) mirror();
      };
      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
      server.watcher.on("unlink", onChange);
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: INDEX_PATH, source: generate() });
    },
  };
}
