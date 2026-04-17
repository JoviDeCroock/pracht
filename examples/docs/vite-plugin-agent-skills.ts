/**
 * Vite plugin that publishes an Agent Skills Discovery index
 * (https://github.com/cloudflare/agent-skills-discovery-rfc).
 *
 * Reads SKILL.md files from a directory, computes SHA-256 digests, and
 * exposes two things:
 *   - /skills/<name>/SKILL.md — the skill source, served as a public asset
 *   - /.well-known/agent-skills/index.json — the discovery manifest that
 *     points at each /skills/<name>/SKILL.md URL
 *
 * In dev, the same paths are served from the dev middleware.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

function buildFiles(
  origin: string,
  schemaUrl: string,
  publicPrefix: string,
  skills: SkillEntry[],
): { fileName: string; source: string }[] {
  const files: { fileName: string; source: string }[] = [];
  const items = skills.map((skill) => {
    const fileName = `${publicPrefix}/${skill.name}/SKILL.md`;
    const sha256 = createHash("sha256").update(skill.source).digest("hex");
    files.push({ fileName, source: skill.source });
    return {
      name: skill.name,
      type: "claude-skill",
      description: skill.description,
      url: `${origin}/${fileName}`,
      sha256,
    };
  });

  const json = JSON.stringify({ $schema: schemaUrl, skills: items }, null, 2) + "\n";
  files.push({ fileName: INDEX_PATH, source: json });
  return files;
}

function normalizePrefix(value: string | undefined): string {
  const raw = (value ?? "/skills").replace(/^\/+|\/+$/g, "");
  return raw || "skills";
}

export function agentSkills(options: AgentSkillsPluginOptions): Plugin {
  const origin = options.origin.replace(/\/$/, "");
  const schemaUrl = options.schemaUrl ?? DEFAULT_SCHEMA;
  const publicPrefix = normalizePrefix(options.publicPrefix);
  const generate = () => buildFiles(origin, schemaUrl, publicPrefix, readSkills(options.skillsDir));

  return {
    name: "pracht-agent-skills",
    apply(_config, env) {
      return env.command === "serve" || (env.command === "build" && !env.isSsrBuild);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        if (url === `/${INDEX_PATH}`) {
          const { source } = generate().find((f) => f.fileName === INDEX_PATH)!;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(source);
          return;
        }
        const skillMatch = url.match(new RegExp(`^/${publicPrefix}/([^/]+)/SKILL\\.md$`));
        if (skillMatch) {
          const file = generate().find((f) => f.fileName.endsWith(`/${skillMatch[1]}/SKILL.md`));
          if (!file) return next();
          res.setHeader("content-type", "text/markdown; charset=utf-8");
          res.end(file.source);
          return;
        }
        next();
      });
    },
    generateBundle() {
      for (const file of generate()) {
        this.emitFile({ type: "asset", fileName: file.fileName, source: file.source });
      }
    },
  };
}
