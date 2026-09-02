import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { defineCommand } from "citty";

import { handleCliError } from "../utils.js";

/**
 * The published Agent Skills Discovery index
 * (https://github.com/cloudflare/agent-skills-discovery-rfc). `create-pracht`
 * seeds a small core set into new apps and points here for the rest, so this
 * command is how the other ~28 skills get installed without every scaffold
 * carrying 360 KB it will never read.
 */
const DEFAULT_INDEX_URL = "https://pracht.resynapse.dev/.well-known/agent-skills/index.json";

interface SkillIndexEntry {
  name: string;
  description: string;
  url: string;
  sha256: string;
}

async function fetchIndex(indexUrl: string): Promise<SkillIndexEntry[]> {
  let response: Response;
  try {
    response = await fetch(indexUrl);
  } catch (error) {
    throw new Error(`Could not reach the skill index at ${indexUrl}: ${String(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Skill index at ${indexUrl} responded ${response.status}`);
  }
  const body = (await response.json()) as { skills?: unknown };
  if (!Array.isArray(body.skills)) {
    throw new Error(`Skill index at ${indexUrl} has no "skills" array`);
  }
  return body.skills.filter(
    (entry): entry is SkillIndexEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as SkillIndexEntry).name === "string" &&
      typeof (entry as SkillIndexEntry).url === "string",
  );
}

function skillPath(cwd: string, name: string): string {
  return resolve(cwd, ".claude/skills", name, "SKILL.md");
}

/**
 * The index publishes a digest per skill. Verifying it is what makes it safe
 * to write a fetched file straight into the directory a coding agent loads
 * from without a human reading it first.
 */
async function download(entry: SkillIndexEntry): Promise<string> {
  const response = await fetch(entry.url);
  if (!response.ok) {
    throw new Error(`${entry.name}: ${entry.url} responded ${response.status}`);
  }
  const source = await response.text();
  if (entry.sha256) {
    const digest = createHash("sha256").update(source).digest("hex");
    if (digest !== entry.sha256) {
      throw new Error(
        `${entry.name}: sha256 mismatch (index says ${entry.sha256}, downloaded ${digest})`,
      );
    }
  }
  return source;
}

const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List the skills published in the pracht skill catalog",
  },
  args: {
    index: {
      type: "string",
      description: `Skill index URL (default ${DEFAULT_INDEX_URL})`,
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args }) {
    const cwd = process.cwd();
    try {
      const skills = await fetchIndex(args.index ?? DEFAULT_INDEX_URL);
      const rows = skills.map((skill) => ({
        name: skill.name,
        description: skill.description ?? "",
        installed: existsSync(skillPath(cwd, skill.name)),
      }));

      if (args.json) {
        console.log(JSON.stringify({ ok: true, skills: rows }, null, 2));
        return;
      }

      const width = Math.max(...rows.map((row) => row.name.length), 0);
      for (const row of rows) {
        const mark = row.installed ? "*" : " ";
        // A catalog description is a paragraph; a list needs a line. `--json`
        // carries the whole thing for anything that wants it.
        const summary = row.description.replace(/\s+/g, " ").slice(0, 78);
        const ellipsis = row.description.replace(/\s+/g, " ").length > 78 ? "…" : "";
        console.log(`${mark} ${row.name.padEnd(width)}  ${summary}${ellipsis}`);
      }
      console.log(`\n${rows.filter((row) => row.installed).length}/${rows.length} installed here.`);
      console.log("Install with: pracht skills add <name...>");
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});

const addCommand = defineCommand({
  meta: {
    name: "add",
    description: "Install skills from the pracht catalog into .claude/skills/",
  },
  args: {
    names: {
      type: "positional",
      description: "Skill names, e.g. audit-loaders add-db",
      required: true,
    },
    force: {
      type: "boolean",
      description: "Overwrite a skill that is already installed",
    },
    index: {
      type: "string",
      description: `Skill index URL (default ${DEFAULT_INDEX_URL})`,
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
    },
  },
  async run({ args, rawArgs }) {
    const cwd = process.cwd();
    // citty binds one positional to `names`; the rest arrive as bare rawArgs.
    const requested = [
      ...new Set(rawArgs.filter((arg) => !arg.startsWith("-") && arg !== args.index)),
    ];

    try {
      if (requested.length === 0) {
        throw new Error("Name at least one skill. See `pracht skills list`.");
      }
      const skills = await fetchIndex(args.index ?? DEFAULT_INDEX_URL);
      const byName = new Map(skills.map((skill) => [skill.name, skill]));

      const unknown = requested.filter((name) => !byName.has(name));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown skill${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
            "Run `pracht skills list` for the catalog.",
        );
      }

      const installed: string[] = [];
      const skipped: string[] = [];
      for (const name of requested) {
        const target = skillPath(cwd, name);
        if (existsSync(target) && !args.force) {
          skipped.push(name);
          continue;
        }
        const source = await download(byName.get(name) as SkillIndexEntry);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source, "utf-8");
        installed.push(name);
      }

      if (args.json) {
        console.log(JSON.stringify({ ok: true, installed, skipped }, null, 2));
        return;
      }
      for (const name of installed) console.log(`added .claude/skills/${name}/SKILL.md`);
      for (const name of skipped) {
        console.log(`skipped ${name} (already installed; --force to overwrite)`);
      }
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }
  },
});

export default defineCommand({
  meta: {
    name: "skills",
    description: "List and install pracht Claude Code skills",
  },
  subCommands: {
    add: addCommand,
    list: listCommand,
  },
});
