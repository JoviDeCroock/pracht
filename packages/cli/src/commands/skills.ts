import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

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

/** A slow or hanging index should fail the command, not hold the terminal. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Everything below treats the index as untrusted input. It is fetched over the
 * network and its contents are written into the directory a coding agent loads
 * instructions from, so a compromised or typo'd index must not be able to
 * choose the path, skip verification, or downgrade the transport.
 */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

interface SkillIndexEntry {
  name: string;
  description: string;
  url: string;
  sha256: string;
}

/**
 * Plaintext defeats the digest: an attacker who can rewrite the response can
 * rewrite the digest with it. Loopback stays allowed so a test (or an offline
 * mirror) can serve an index without a certificate.
 */
function assertTransport(rawUrl: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${what} is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error(`${what} must use https (http is allowed only for localhost): ${rawUrl}`);
}

async function fetchWithTimeout(url: URL, what: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : String(error);
    throw new Error(`Could not reach ${what} at ${url.href}: ${reason}`);
  }
}

/**
 * Rejects the whole index rather than the offending entry: a skill catalog
 * that cannot describe one of its own entries safely is not a catalog to
 * install selectively from.
 */
function validateEntries(indexUrl: URL, skills: unknown[]): SkillIndexEntry[] {
  return skills.map((raw, i) => {
    const entry = raw as Partial<SkillIndexEntry>;
    const at = `${indexUrl.href} entry ${i}`;
    if (typeof entry?.name !== "string" || !SKILL_NAME.test(entry.name)) {
      throw new Error(`${at} has an unusable name: ${JSON.stringify(entry?.name)}`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      throw new Error(`${at} (${entry.name}) has no 64-character hex sha256`);
    }
    if (typeof entry.url !== "string") {
      throw new Error(`${at} (${entry.name}) has no url`);
    }
    assertTransport(entry.url, `Skill url for "${entry.name}"`);
    return {
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : "",
      url: entry.url,
      sha256: entry.sha256,
    };
  });
}

async function fetchIndex(rawIndexUrl: string): Promise<SkillIndexEntry[]> {
  const indexUrl = assertTransport(rawIndexUrl, "Skill index URL");
  const response = await fetchWithTimeout(indexUrl, "the skill index");
  if (!response.ok) {
    throw new Error(`Skill index at ${indexUrl.href} responded ${response.status}`);
  }
  let body: { skills?: unknown };
  try {
    body = (await response.json()) as { skills?: unknown };
  } catch (error) {
    throw new Error(`Skill index at ${indexUrl.href} is not JSON: ${String(error)}`);
  }
  if (!Array.isArray(body.skills)) {
    throw new Error(`Skill index at ${indexUrl.href} has no "skills" array`);
  }
  return validateEntries(indexUrl, body.skills);
}

/**
 * Resolve `.claude/skills`, refusing anything that would write somewhere the
 * caller did not name.
 *
 * Two separate hazards. A symlinked `.claude/skills` redirects every write:
 * this very repository symlinks it at its own canonical `skills/` sources, so
 * an `add` run here would silently rewrite the catalog it publishes. And a
 * name from the index is interpolated into the path, so `../../etc` has to be
 * impossible even before `SKILL_NAME` rejects it.
 */
function resolveSkillsRoot(cwd: string, force: boolean): string {
  const root = resolve(cwd, ".claude", "skills");
  if (!existsSync(root)) return root;

  const real = realpathSync(root);
  if (real === root) return root;

  const project = realpathSync(cwd);
  const inProject = real === project || real.startsWith(project + sep);
  if (!inProject) {
    throw new Error(
      `${root} is a symlink to ${real}, which is outside ${project}. ` +
        "Refusing to install through it — replace it with a real directory.",
    );
  }
  if (!force) {
    throw new Error(
      `${root} is a symlink to ${real}. Installing would rewrite that directory, ` +
        "not a copy. Pass --force if that is what you want.",
    );
  }
  return root;
}

function skillPath(skillsRoot: string, name: string): string {
  if (!SKILL_NAME.test(name)) {
    throw new Error(`Unusable skill name: ${JSON.stringify(name)}`);
  }
  const target = resolve(skillsRoot, name, "SKILL.md");
  // Belt and braces: `SKILL_NAME` already forbids separators and dots, so this
  // can only fire if that regex is ever loosened.
  if (target !== join(skillsRoot, name, "SKILL.md") || !target.startsWith(skillsRoot + sep)) {
    throw new Error(`Skill "${name}" resolves outside ${skillsRoot}`);
  }
  return target;
}

/**
 * The index publishes a digest per skill, and `validateEntries` has already
 * refused an index that omits one. Checking it here is what makes it safe to
 * write a fetched file straight into the directory a coding agent loads from
 * without a human reading it first.
 */
async function download(entry: SkillIndexEntry): Promise<string> {
  const url = assertTransport(entry.url, `Skill url for "${entry.name}"`);
  const response = await fetchWithTimeout(url, `skill "${entry.name}"`);
  if (!response.ok) {
    throw new Error(`${entry.name}: ${url.href} responded ${response.status}`);
  }
  const source = await response.text();
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(
      `${entry.name}: sha256 mismatch (index says ${entry.sha256}, downloaded ${digest})`,
    );
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
      // Listing never writes, so a symlinked directory is only a question of
      // where "installed" is being read from.
      const skillsRoot = resolve(cwd, ".claude", "skills");
      const rows = skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        installed: existsSync(skillPath(skillsRoot, skill.name)),
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
        const summary = row.description.replace(/\s+/g, " ");
        const shown = summary.length > 78 ? `${summary.slice(0, 78)}…` : summary;
        console.log(`${mark} ${row.name.padEnd(width)}  ${shown}`);
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

    const installed: string[] = [];
    const skipped: string[] = [];
    const failed: { name: string; error: string }[] = [];

    try {
      if (requested.length === 0) {
        throw new Error("Name at least one skill. See `pracht skills list`.");
      }
      const skillsRoot = resolveSkillsRoot(cwd, Boolean(args.force));
      const byName = new Map(
        (await fetchIndex(args.index ?? DEFAULT_INDEX_URL)).map((s) => [s.name, s]),
      );

      const unknown = requested.filter((name) => !byName.has(name));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown skill${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ` +
            "Run `pracht skills list` for the catalog.",
        );
      }

      for (const name of requested) {
        const target = skillPath(skillsRoot, name);
        if (existsSync(target) && !args.force) {
          skipped.push(name);
          continue;
        }
        try {
          const source = await download(byName.get(name) as SkillIndexEntry);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, source, "utf-8");
          installed.push(name);
        } catch (error) {
          // One bad entry does not invalidate the others, but it does have to
          // be reported and it does have to fail the command.
          failed.push({ name, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      handleCliError(error, { json: Boolean(args.json) });
    }

    if (args.json) {
      console.log(JSON.stringify({ ok: failed.length === 0, installed, skipped, failed }, null, 2));
    } else {
      for (const name of installed) console.log(`added .claude/skills/${name}/SKILL.md`);
      for (const name of skipped) {
        console.log(`skipped ${name} (already installed; --force to overwrite)`);
      }
      for (const entry of failed) console.error(`failed ${entry.name}: ${entry.error}`);
    }

    if (failed.length > 0) process.exit(1);
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
