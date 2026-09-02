import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { defineCommand } from "citty";

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

function insideProject(project: string, path: string): boolean {
  return path === project || path.startsWith(project + sep);
}

/**
 * Where `path` really is, or `null` when nothing is there.
 *
 * `realpathSync` covers the ordinary cases including symlinked ancestors, but
 * throws on a dangling link — and a link to a directory that does not exist
 * yet is precisely how a write gets redirected without `existsSync` ever
 * returning true. Fall back to reading the link itself.
 */
function locate(path: string): string | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  try {
    return realpathSync(path);
  } catch {
    const raw = readlinkSync(path);
    return isAbsolute(raw) ? resolve(raw) : resolve(dirname(path), raw);
  }
}

/**
 * The one containment rule, applied to every path this command writes
 * through: `.claude/skills`, the skill directory under it, and `SKILL.md`
 * itself.
 *
 * Vetting only `.claude/skills` is not enough. A symlink one level deeper —
 * `.claude/skills/audit-seo` pointing at somewhere else entirely — is followed
 * by `writeFileSync` just the same, and because the link's target need not
 * exist yet, the "already installed" check does not even see it.
 *
 * A redirect that leaves the project is always refused. One that stays inside
 * it is refused unless `--force`, because writing through a link changes the
 * thing it points at rather than a copy: this repository points its own
 * `.claude/skills` at the canonical `skills/` sources it publishes.
 */
function assertNotRedirected(project: string, path: string, force: boolean, what: string): void {
  const real = locate(path);
  if (real === null || real === path) return;
  if (!insideProject(project, real)) {
    throw new Error(
      `${what} ${path} resolves to ${real}, outside ${project}. ` +
        "Refusing to write through it — replace it with a real directory.",
    );
  }
  if (!force) {
    throw new Error(
      `${what} ${path} is a symlink to ${real}. Writing would change that path, ` +
        "not a copy. Pass --force if that is what you want.",
    );
  }
}

/**
 * Resolve `.claude/skills` against the *real* project root, so a redirect is
 * only ever a symlink and never the platform's own path aliasing (macOS
 * resolves `/tmp` to `/private/tmp`, which would otherwise read as one).
 */
function resolveSkillsRoot(cwd: string, force: boolean): { project: string; root: string } {
  const project = realpathSync(cwd);
  const root = join(project, ".claude", "skills");
  assertNotRedirected(project, root, force, "The skills directory");
  return { project, root };
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
 * `--json` has to be parseable by the same code on every path.
 *
 * The shared `handleCliError` writes its envelope to stderr and omits the
 * result lists, so a caller piping stdout through a parser gets valid JSON for
 * a partial failure and nothing at all for a fatal one. These emit the full
 * shape on stdout either way; the human path keeps the message on stderr where
 * it belongs.
 */
function failJson(json: boolean, error: unknown, extra: Record<string, unknown>): never {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  } else {
    console.error(message);
    if (error instanceof Error && error.stack && process.env.DEBUG) console.error(error.stack);
  }
  process.exit(1);
}

/** The same rule, for the two components below the skills root. */
function assertWritableSkill(
  project: string,
  skillsRoot: string,
  name: string,
  force: boolean,
): string {
  const target = skillPath(skillsRoot, name);
  assertNotRedirected(project, dirname(target), force, `The directory for skill "${name}",`);
  assertNotRedirected(project, target, force, `The file for skill "${name}",`);
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
      failJson(Boolean(args.json), error, { skills: [] });
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
      const { project, root: skillsRoot } = resolveSkillsRoot(cwd, Boolean(args.force));
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
        try {
          // Before the "already installed" check, not after: a link whose
          // target does not exist yet is invisible to `existsSync` and would
          // otherwise be written straight through.
          const target = assertWritableSkill(project, skillsRoot, name, Boolean(args.force));
          if (existsSync(target) && !args.force) {
            skipped.push(name);
            continue;
          }
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
      failJson(Boolean(args.json), error, { installed, skipped, failed });
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
