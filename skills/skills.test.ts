/**
 * Drift guard for the Claude Code skills in skills/<name>/SKILL.md.
 *
 * The skills document the pracht CLI, MCP server, and build output. Nothing
 * ties that prose to the implementation, so it silently rots when commands,
 * flags, tool names, or artifact paths change. This suite re-derives the real
 * surface from the CLI sources at test time (no build required) and checks
 * every SKILL.md against it. It enumerates whatever skill directories exist —
 * no hardcoded skill list or count — so renames and new skills are picked up
 * automatically.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// realpathSync so ROOT resolves to the repo root even if this file is reached
// through the .claude/skills -> ../skills symlink.
const ROOT = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "..");
const SKILLS_DIR = join(ROOT, "skills");
const CLI_SRC = join(ROOT, "packages/cli/src");

// ---------------------------------------------------------------------------
// Fixed vocabularies (frozen deliberately; extend on purpose, not by accident)
// ---------------------------------------------------------------------------

// Union of every tool used across skills/*/SKILL.md at the time this guard was
// written. Frozen so a typo ("Wrte") or an unvetted tool grant fails loudly.
const KNOWN_TOOLS = new Set(["AskUserQuestion", "Bash", "Edit", "Glob", "Grep", "Read", "Write"]);

// audit-* skills are read-only by policy: they report, they don't mutate the
// project. Edit is never allowed. Write is allowed only for skills that
// legitimately emit new artifacts as part of the audit:
// - audit-a11y writes a one-off axe runner script (scripts/audit-a11y.ts) and
//   its JSON report when Playwright is not already wired.
// - audit-seo generates sitemap.xml / robots.txt drafts from the route
//   manifest (its Step 5 is explicitly about emitting a sitemap).
const AUDIT_WRITE_EXCEPTIONS = new Set(["audit-a11y", "audit-seo"]);

// Old skill names that were renamed with a `pracht-` prefix. A `/debug`-style
// cross-reference to one of these is stale and must point at the new name.
const RENAMED_SKILLS: Record<string, string> = {
  debug: "pracht-debug",
  deploy: "pracht-deploy",
  scaffold: "pracht-scaffold",
  "test-api": "pracht-test-api",
};

// Flags handled outside citty arg definitions: index.ts special-cases
// --version/-v before runMain, and citty itself provides usage/--help.
const GLOBAL_CLI_FLAGS = new Set(["help", "version"]);

// Build artifacts the skills may reference. Every entry is verified against
// the build implementation:
// - dist/server outDir + entry: packages/cli/src/commands/build.ts
//   ("dist/server", "dist/server/server.js")
// - Cloudflare deploy entry: build.ts writes "dist/server/worker.js"
// - ISG manifest: build.ts writes "dist/server/isg-manifest.json"
// - Headers manifest: build.ts writes "dist/server/headers-manifest.json"
// - Budget report: build.ts writes "dist/server/budget-report.json"
// - Client copies of manifests: build.ts writes "_pracht/headers.json" and
//   "_pracht/isg.json" under the client dir ("dist/client")
// - Vite client manifest: build.ts / build-metadata.ts read
//   "dist/client/.vite/manifest.json"
// - Prerendered route HTML: build.ts writes "<route>/index.html" under
//   dist/client (routeToStaticHtmlPath in build-shared.ts)
// - Vercel Build Output API: build-shared.ts writeVercelBuildOutput emits
//   .vercel/output/config.json, .vercel/output/static/ (copy of dist/client),
//   and .vercel/output/functions/<functionName>.func/ (copy of dist/server,
//   default function name "render")
const BUILD_OUTPUT_PATTERNS: RegExp[] = [
  /^dist\/(?:client|server)\/?$/,
  /^dist\/server\/(?:server\.js|worker\.js|isg-manifest\.json|headers-manifest\.json|budget-report\.json)$/,
  /^dist\/client\/_pracht\/?$/,
  /^dist\/client\/_pracht\/(?:headers\.json|isg\.json)$/,
  /^dist\/client\/\.vite\/manifest\.json$/,
  /^dist\/client(?:\/[^/.]+)+\/index\.html$/,
  /^\.vercel\/output\/?$/,
  /^\.vercel\/output\/config\.json$/,
  /^\.vercel\/output\/static\/?(?:[\w\-./<>:[\]]*)$/,
  /^\.vercel\/output\/functions\/[\w<>-]+\.func\/?(?:[\w\-./<>:[\]]*)$/,
];

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------
// Frontmatter parsing (strict subset of YAML used by the skill files)
// ---------------------------------------------------------------------------

interface SkillFile {
  allowedTools: string[];
  body: string;
  description: string;
  keys: string[];
  name: string;
  version: string;
}

/**
 * The skills only use scalar values, one `|` block scalar (description), and
 * one string list (allowed-tools). Parsing that subset by hand keeps the test
 * dependency-free while still rejecting anything structurally unexpected.
 */
function parseSkillFile(raw: string, file: string): SkillFile {
  const lines = raw.split("\n");
  if (lines[0] !== "---") {
    throw new Error(`${file}: must start with a "---" frontmatter fence`);
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error(`${file}: frontmatter fence is never closed`);
  }

  const keys: string[] = [];
  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};

  let i = 1;
  while (i < end) {
    const line = lines[i];
    const keyMatch = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (!keyMatch) {
      throw new Error(`${file}: unexpected frontmatter line ${i + 1}: ${JSON.stringify(line)}`);
    }
    const key = keyMatch[1];
    const rest = keyMatch[2].trim();
    keys.push(key);
    i += 1;

    if (rest === "|" || rest === "|-") {
      const block: string[] = [];
      while (i < end && (lines[i].startsWith("  ") || lines[i] === "")) {
        block.push(lines[i].replace(/^ {2}/, ""));
        i += 1;
      }
      scalars[key] = block.join("\n").trim();
    } else if (rest === "") {
      const list: string[] = [];
      while (i < end && /^ {2}- /.test(lines[i])) {
        list.push(lines[i].replace(/^ {2}- /, "").trim());
        i += 1;
      }
      lists[key] = list;
    } else {
      scalars[key] = rest;
    }
  }

  return {
    allowedTools: lists["allowed-tools"] ?? [],
    body: lines.slice(end + 1).join("\n"),
    description: scalars["description"] ?? "",
    keys,
    name: scalars["name"] ?? "",
    version: scalars["version"] ?? "",
  };
}

// ---------------------------------------------------------------------------
// CLI surface extraction (read straight from the TypeScript sources)
// ---------------------------------------------------------------------------

const cliIndexSource = readFileSync(join(CLI_SRC, "index.ts"), "utf-8");

/** `pracht` subcommand -> absolute path of its citty command module. */
const CLI_SUBCOMMANDS = new Map<string, string>(
  [
    ...cliIndexSource.matchAll(
      /(\w[\w-]*):\s*\(\)\s*=>\s*import\("\.\/commands\/([\w.-]+)\.js"\)/g,
    ),
  ].map((m) => [m[1], join(CLI_SRC, "commands", `${m[2]}.ts`)]),
);

/**
 * Collect citty arg names from a command module. Arg definitions all have the
 * shape `key: { type: "..." }` (possibly across lines), which sidesteps
 * brace-matching through template-literal descriptions. Positional args are
 * included; that slightly loosens the flag check but never rejects a real flag.
 */
function cittyArgNames(commandFile: string): Set<string> {
  const source = readFileSync(commandFile, "utf-8");
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:"([\w-]+)"|(\w[\w-]*)):\s*\{\s*type:\s*"/g)) {
    names.add(match[1] ?? match[2]);
  }
  return names;
}

const cliArgCache = new Map<string, Set<string>>();
function flagsForSubcommand(subcommand: string): Set<string> {
  const file = CLI_SUBCOMMANDS.get(subcommand);
  if (!file) return GLOBAL_CLI_FLAGS;
  let flags = cliArgCache.get(file);
  if (!flags) {
    flags = new Set([...cittyArgNames(file), ...GLOBAL_CLI_FLAGS]);
    cliArgCache.set(file, flags);
  }
  return flags;
}

const mcpServerSource = readFileSync(join(CLI_SRC, "mcp-server.ts"), "utf-8");
const MCP_TOOLS = new Set(
  [...mcpServerSource.matchAll(/registerTool\(\s*"([\w-]+)"/g)].map((m) => m[1]),
);

// ---------------------------------------------------------------------------
// Body extraction helpers
// ---------------------------------------------------------------------------

interface PrachtInvocation {
  /** Everything after `pracht `, cut at shell separators/comments. */
  argv: string[];
  source: string;
}

const COMMAND_PREFIX_RE = /^(?:\$\s+)?(?:(?:npx|pnpx)\s+|pnpm\s+(?:exec\s+)?)?/;

function toInvocation(commandText: string): PrachtInvocation | null {
  const stripped = commandText.replace(COMMAND_PREFIX_RE, "");
  if (!/^pracht\s/.test(stripped)) return null;
  // Keep only the pracht command itself: cut at shell operators and comments
  // so `pracht build && wrangler deploy --remote` doesn't leak wrangler flags.
  const rest = stripped
    .slice("pracht".length)
    .split(/\s(?:&&|\|\||\||;|#|>|2>)\s?/)[0]
    .trim();
  if (rest === "") return null;
  return { argv: rest.split(/\s+/), source: commandText.trim() };
}

/**
 * Extract `pracht ...` invocations from fenced code blocks (command position
 * on the line, or embedded in a quoted string such as a Playwright
 * `webServer.command`) and from inline backtick spans that start with the
 * command. Prose mentions like "the pracht plugin" never match.
 */
function extractPrachtInvocations(body: string): PrachtInvocation[] {
  const invocations: PrachtInvocation[] = [];
  const fences = [...body.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1]);

  for (const fence of fences) {
    for (const line of fence.split("\n")) {
      const direct = toInvocation(line.trim());
      if (direct) invocations.push(direct);
      for (const quoted of line.matchAll(/["'`]([^"'`\n]+)["'`]/g)) {
        const embedded = toInvocation(quoted[1].trim());
        if (embedded) invocations.push(embedded);
      }
    }
  }

  const withoutFences = body.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
  for (const span of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    const inline = toInvocation(span[1].trim());
    if (inline) invocations.push(inline);
  }

  return invocations;
}

// ---------------------------------------------------------------------------
// Load the skills
// ---------------------------------------------------------------------------

const skillNames = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const skills = skillNames.map((name) => {
  const file = join(SKILLS_DIR, name, "SKILL.md");
  return { file, name, raw: readFileSync(file, "utf-8") };
});

const parsedCache = new Map<string, SkillFile>();
function parsed(skill: { file: string; name: string; raw: string }): SkillFile {
  let result = parsedCache.get(skill.name);
  if (!result) {
    result = parseSkillFile(skill.raw, `skills/${skill.name}/SKILL.md`);
    parsedCache.set(skill.name, result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sanity: the extraction itself must keep working, or every check is vacuous
// ---------------------------------------------------------------------------

describe("drift-guard source extraction", () => {
  it("finds skill directories with a SKILL.md each", () => {
    expect(skillNames.length).toBeGreaterThanOrEqual(20);
    for (const skill of skills) {
      expect(existsSync(skill.file), `${skill.file} is missing`).toBe(true);
    }
  });

  it("extracts the CLI subcommand registry from packages/cli/src/index.ts", () => {
    expect(CLI_SUBCOMMANDS.size).toBeGreaterThanOrEqual(5);
    for (const [subcommand, file] of CLI_SUBCOMMANDS) {
      expect(existsSync(file), `command module for "pracht ${subcommand}" not found: ${file}`).toBe(
        true,
      );
    }
  });

  it("extracts citty flags from the command modules", () => {
    // Every registered command except `mcp` (which takes no args) defines args.
    const withArgs = [...CLI_SUBCOMMANDS.keys()].filter(
      (sub) => cittyArgNames(CLI_SUBCOMMANDS.get(sub) as string).size > 0,
    );
    expect(withArgs.length).toBeGreaterThanOrEqual(CLI_SUBCOMMANDS.size - 1);
  });

  it("extracts MCP tool names from packages/cli/src/mcp-server.ts", () => {
    expect(MCP_TOOLS.size).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Per-skill checks
// ---------------------------------------------------------------------------

describe.each(skills)("skills/$name/SKILL.md", (skill) => {
  it("has valid frontmatter (name, version, description, allowed-tools)", () => {
    const fm = parsed(skill);
    // The skills uniformly carry exactly these four keys. If a new standard
    // key is adopted, add it here deliberately.
    expect(fm.keys.slice().sort()).toEqual(["allowed-tools", "description", "name", "version"]);
    expect(fm.name).toBe(skill.name);
    expect(fm.version).toMatch(SEMVER_RE);
    expect(fm.description.length).toBeGreaterThan(0);
    expect(fm.allowedTools.length).toBeGreaterThan(0);
    for (const tool of fm.allowedTools) {
      expect(KNOWN_TOOLS, `unknown tool "${tool}" in allowed-tools`).toContain(tool);
    }
    expect(new Set(fm.allowedTools).size).toBe(fm.allowedTools.length);
  });

  it("ends with $ARGUMENTS", () => {
    const nonEmpty = parsed(skill)
      .body.split("\n")
      .filter((line) => line.trim() !== "");
    expect(nonEmpty.at(-1)).toBe("$ARGUMENTS");
  });

  it("only references real pracht CLI subcommands and flags", () => {
    for (const invocation of extractPrachtInvocations(parsed(skill).body)) {
      const [first, ...rest] = invocation.argv;
      if (first.startsWith("-")) {
        // Bare-flag invocation like `pracht --version` (handled in index.ts).
        continue;
      }
      const subcommand = /^[a-z][\w-]*$/.exec(first)?.[0];
      if (!subcommand) continue; // placeholder like `pracht <command>`
      expect(
        CLI_SUBCOMMANDS.has(subcommand),
        `"pracht ${subcommand}" (from \`${invocation.source}\`) is not a registered CLI subcommand; known: ${[...CLI_SUBCOMMANDS.keys()].join(", ")}`,
      ).toBe(true);

      const allowedFlags = flagsForSubcommand(subcommand);
      for (const token of rest) {
        const flag = /^--([a-z][\w-]*)(?:=.*)?$/.exec(token)?.[1];
        if (!flag) continue;
        const normalized = flag.replace(/^no-/, "");
        expect(
          allowedFlags.has(flag) || allowedFlags.has(normalized),
          `flag "--${flag}" (from \`${invocation.source}\`) is not defined by "pracht ${subcommand}"; known: ${[...allowedFlags].map((f) => `--${f}`).join(", ")}`,
        ).toBe(true);
      }
    }
  });

  it("only references real MCP tool names", () => {
    // Scoped to the inspect_*/generate_* families to avoid matching unrelated
    // snake_case identifiers (node_modules, worker_threads, ...). The bare
    // `doctor`/`verify` tools share their names with CLI subcommands and are
    // covered by the CLI registry check.
    for (const match of parsed(skill).body.matchAll(/\b(?:inspect|generate)_[a-z][a-z0-9_]*\b/g)) {
      expect(
        MCP_TOOLS.has(match[0]),
        `MCP tool "${match[0]}" is not registered in packages/cli/src/mcp-server.ts; known: ${[...MCP_TOOLS].join(", ")}`,
      ).toBe(true);
    }
  });

  it("only references real build output paths", () => {
    const pathRe = /(?:dist\/(?:server|client)|\.vercel\/output)[\w\-./<>:*[\]]*/g;
    for (const match of parsed(skill).body.matchAll(pathRe)) {
      const path = match[0].replace(/[.,]+$/, "");
      expect(
        BUILD_OUTPUT_PATTERNS.some((pattern) => pattern.test(path)),
        `build output path "${path}" does not match any artifact the build actually produces (see BUILD_OUTPUT_PATTERNS)`,
      ).toBe(true);
    }
  });

  it("only cross-references skills that exist", () => {
    const fm = parsed(skill);
    const knownNames = new Set([...skillNames, ...Object.keys(RENAMED_SKILLS)]);
    const text = `${fm.description}\n${fm.body}`;
    // Only slash tokens whose name is a current or pre-rename skill name are
    // treated as skill references; URL/file paths (/api/health, src/routes/...)
    // are excluded by the lookbehind and the name filter.
    for (const match of text.matchAll(/(?<![\w.:/@-])\/([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g)) {
      const name = match[1];
      if (!knownNames.has(name)) continue;
      const hint = RENAMED_SKILLS[name] ? ` (renamed to /${RENAMED_SKILLS[name]})` : "";
      expect(
        skillNames.includes(name),
        `"/${name}" references a skill that no longer exists${hint}`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tool policy for audit skills
// ---------------------------------------------------------------------------

describe("audit-* tool policy", () => {
  const auditSkills = skills.filter((skill) => skill.name.startsWith("audit-"));

  it("covers at least the current audit skills", () => {
    expect(auditSkills.length).toBeGreaterThanOrEqual(5);
  });

  it.each(auditSkills)("$name never allows Edit", (skill) => {
    expect(parsed(skill).allowedTools).not.toContain("Edit");
  });

  it.each(auditSkills)("$name only allows Write when explicitly excepted", (skill) => {
    if (parsed(skill).allowedTools.includes("Write")) {
      expect(
        AUDIT_WRITE_EXCEPTIONS.has(skill.name),
        `${skill.name} grants Write but is not in AUDIT_WRITE_EXCEPTIONS — audits are read-only unless they emit artifacts by design`,
      ).toBe(true);
    }
  });
});
