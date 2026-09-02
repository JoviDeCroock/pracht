// `pracht skills add` fetches from a network index and writes into the
// directory a coding agent loads instructions from, so the index is untrusted
// input on every axis: the name it supplies becomes a path, the digest it
// supplies is the only thing standing between a rewritten response and an
// agent's system prompt, and the URL it supplies chooses the transport.
//
// Every test here serves a real index over loopback HTTP rather than mocking
// `fetch`, because the transport rules are part of what is being tested.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempDirs, cliPath, createTempDir } from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

/**
 * Asynchronous on purpose. The shared `runCliStatus` helper uses `spawnSync`,
 * which would block the event loop the fixture server below runs on — the
 * CLI's fetch could never be answered and every test would sit out its 30s
 * timeout instead of asserting anything.
 */
function runCli(args, { cwd }) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => settle({ status, stdout, stderr }));
  });
}

const SKILL_A = "---\nname: audit-loaders\n---\n\nBody A.\n";
const SKILL_B = "---\nname: add-db\n---\n\nBody B.\n";

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

/**
 * Serves `/skills/<name>/SKILL.md` plus the discovery index.
 *
 * `entries` describes the index; `bodies` describes what is actually served,
 * so a test can make the two disagree.
 */
async function startIndexServer({ entries, bodies }) {
  let baseUrl;
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/.well-known/agent-skills/index.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ skills: entries(baseUrl) }));
      return;
    }
    const match = /^\/skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (match && bodies[match[1]] !== undefined) {
      response.writeHead(200, { "content-type": "text/markdown" });
      response.end(bodies[match[1]]);
      return;
    }
    response.writeHead(404).end("no");
  });

  await new Promise((settle) => server.listen(0, "127.0.0.1", settle));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    indexUrl: `${baseUrl}/.well-known/agent-skills/index.json`,
    baseUrl,
    async close() {
      await new Promise((settle) => server.close(settle));
    },
  };
}

/** The well-formed catalog the happy-path tests use. */
function goodEntries(baseUrl) {
  return [
    {
      name: "audit-loaders",
      type: "claude-skill",
      description: "Audit pracht route loaders. Second sentence.",
      url: `${baseUrl}/skills/audit-loaders/SKILL.md`,
      sha256: sha256(SKILL_A),
    },
    {
      name: "add-db",
      type: "claude-skill",
      description: "Wire Drizzle ORM.",
      url: `${baseUrl}/skills/add-db/SKILL.md`,
      sha256: sha256(SKILL_B),
    },
  ];
}

const goodBodies = { "audit-loaders": SKILL_A, "add-db": SKILL_B };

async function withIndex(config, run) {
  const server = await startIndexServer(config);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

function skillFile(appDir, name) {
  return join(appDir, ".claude/skills", name, "SKILL.md");
}

describe("@pracht/cli skills", () => {
  it("lists the catalog and marks what is already installed", async () => {
    const appDir = createTempDir("pracht-cli-skills-list-");
    mkdirSync(join(appDir, ".claude/skills/add-db"), { recursive: true });
    writeFileSync(skillFile(appDir, "add-db"), SKILL_B, "utf-8");

    await withIndex({ entries: goodEntries, bodies: goodBodies }, async ({ indexUrl }) => {
      const result = await runCli(["skills", "list", "--index", indexUrl, "--json"], {
        cwd: appDir,
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.skills).toEqual([
        {
          name: "audit-loaders",
          description: "Audit pracht route loaders. Second sentence.",
          installed: false,
        },
        { name: "add-db", description: "Wire Drizzle ORM.", installed: true },
      ]);
    });
  });

  it("installs a verified skill and reports it", async () => {
    const appDir = createTempDir("pracht-cli-skills-add-");

    await withIndex({ entries: goodEntries, bodies: goodBodies }, async ({ indexUrl }) => {
      const result = await runCli(
        ["skills", "add", "audit-loaders", "add-db", "--index", indexUrl, "--json"],
        { cwd: appDir },
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        installed: ["audit-loaders", "add-db"],
        skipped: [],
        failed: [],
      });
      expect(readFileSync(skillFile(appDir, "audit-loaders"), "utf-8")).toBe(SKILL_A);
      expect(readFileSync(skillFile(appDir, "add-db"), "utf-8")).toBe(SKILL_B);
    });
  });

  it("refuses a body that does not match the published digest", async () => {
    const appDir = createTempDir("pracht-cli-skills-tampered-");

    await withIndex(
      {
        entries: goodEntries,
        // The index still advertises the digest of SKILL_A.
        bodies: { ...goodBodies, "audit-loaders": "---\nname: audit-loaders\n---\n\nPwned.\n" },
      },
      async ({ indexUrl }) => {
        const result = await runCli(
          ["skills", "add", "audit-loaders", "--index", indexUrl, "--json"],
          { cwd: appDir },
        );

        expect(result.status).toBe(1);
        const output = JSON.parse(result.stdout);
        expect(output.ok).toBe(false);
        expect(output.installed).toEqual([]);
        expect(output.failed[0].name).toBe("audit-loaders");
        expect(output.failed[0].error).toMatch(/sha256 mismatch/);
        expect(existsSync(skillFile(appDir, "audit-loaders"))).toBe(false);
      },
    );
  });

  it("refuses an index entry with no digest before writing anything", async () => {
    const appDir = createTempDir("pracht-cli-skills-nodigest-");

    await withIndex(
      {
        entries: (baseUrl) => {
          const [first, second] = goodEntries(baseUrl);
          return [first, { ...second, sha256: undefined }];
        },
        bodies: goodBodies,
      },
      async ({ indexUrl }) => {
        // `audit-loaders` is perfectly well-formed and named first, but a
        // catalog that cannot describe one entry safely is not one to install
        // selectively from.
        const result = await runCli(["skills", "add", "audit-loaders", "--index", indexUrl], {
          cwd: appDir,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/has no 64-character hex sha256/);
        expect(existsSync(join(appDir, ".claude"))).toBe(false);
      },
    );
  });

  it("refuses an index name that would escape .claude/skills", async () => {
    const appDir = createTempDir("pracht-cli-skills-traversal-");
    const escapeTarget = join(appDir, "escaped.md");

    await withIndex(
      {
        entries: (baseUrl) => [
          {
            name: "../../escaped",
            type: "claude-skill",
            description: "Traversal.",
            url: `${baseUrl}/skills/audit-loaders/SKILL.md`,
            sha256: sha256(SKILL_A),
          },
        ],
        bodies: goodBodies,
      },
      async ({ indexUrl }) => {
        const result = await runCli(["skills", "add", "../../escaped", "--index", indexUrl], {
          cwd: appDir,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/unusable name/i);
        expect(existsSync(escapeTarget)).toBe(false);
        expect(existsSync(join(appDir, ".claude"))).toBe(false);
      },
    );
  });

  it("refuses a plaintext index that is not on loopback", async () => {
    const appDir = createTempDir("pracht-cli-skills-http-");

    const result = await runCli(["skills", "list", "--index", "http://example.com/index.json"], {
      cwd: appDir,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must use https/);
  });

  it("refuses a plaintext skill url advertised by a loopback index", async () => {
    const appDir = createTempDir("pracht-cli-skills-http-entry-");

    await withIndex(
      {
        entries: () => [
          {
            name: "audit-loaders",
            type: "claude-skill",
            description: "Plaintext elsewhere.",
            url: "http://example.com/skills/audit-loaders/SKILL.md",
            sha256: sha256(SKILL_A),
          },
        ],
        bodies: goodBodies,
      },
      async ({ indexUrl }) => {
        const result = await runCli(["skills", "add", "audit-loaders", "--index", indexUrl], {
          cwd: appDir,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/must use https/);
      },
    );
  });

  it("skips an installed skill and overwrites it with --force", async () => {
    const appDir = createTempDir("pracht-cli-skills-force-");
    mkdirSync(join(appDir, ".claude/skills/audit-loaders"), { recursive: true });
    writeFileSync(skillFile(appDir, "audit-loaders"), "stale\n", "utf-8");

    await withIndex({ entries: goodEntries, bodies: goodBodies }, async ({ indexUrl }) => {
      const skipped = await runCli(
        ["skills", "add", "audit-loaders", "--index", indexUrl, "--json"],
        { cwd: appDir },
      );
      expect(skipped.status).toBe(0);
      expect(JSON.parse(skipped.stdout)).toMatchObject({
        installed: [],
        skipped: ["audit-loaders"],
      });
      expect(readFileSync(skillFile(appDir, "audit-loaders"), "utf-8")).toBe("stale\n");

      const forced = await runCli(
        ["skills", "add", "audit-loaders", "--index", indexUrl, "--force", "--json"],
        { cwd: appDir },
      );
      expect(forced.status).toBe(0);
      expect(JSON.parse(forced.stdout)).toMatchObject({ installed: ["audit-loaders"] });
      expect(readFileSync(skillFile(appDir, "audit-loaders"), "utf-8")).toBe(SKILL_A);
    });
  });

  it("reports a partial batch in full and still exits non-zero", async () => {
    const appDir = createTempDir("pracht-cli-skills-partial-");
    mkdirSync(join(appDir, ".claude/skills/add-db"), { recursive: true });
    writeFileSync(skillFile(appDir, "add-db"), SKILL_B, "utf-8");

    await withIndex(
      {
        entries: goodEntries,
        // Only `audit-loaders` is unservable: its 404 must not stop `add-db`
        // from being reported as skipped.
        bodies: { "add-db": SKILL_B },
      },
      async ({ indexUrl }) => {
        const result = await runCli(
          ["skills", "add", "audit-loaders", "add-db", "--index", indexUrl, "--json"],
          { cwd: appDir },
        );

        expect(result.status).toBe(1);
        const output = JSON.parse(result.stdout);
        expect(output.ok).toBe(false);
        expect(output.installed).toEqual([]);
        expect(output.skipped).toEqual(["add-db"]);
        expect(output.failed).toHaveLength(1);
        expect(output.failed[0].name).toBe("audit-loaders");
        expect(output.failed[0].error).toMatch(/responded 404/);
      },
    );
  });

  // This repository symlinks `.claude/skills` at its own canonical `skills/`
  // sources, so an unguarded `add` run here would rewrite the catalog it
  // publishes rather than a copy.
  it("refuses to install through a symlinked .claude/skills without --force", async () => {
    const appDir = createTempDir("pracht-cli-skills-symlink-");
    const real = join(appDir, "skills");
    mkdirSync(real, { recursive: true });
    mkdirSync(join(appDir, ".claude"), { recursive: true });
    symlinkSync(real, join(appDir, ".claude/skills"));

    await withIndex({ entries: goodEntries, bodies: goodBodies }, async ({ indexUrl }) => {
      const refused = await runCli(["skills", "add", "audit-loaders", "--index", indexUrl], {
        cwd: appDir,
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toMatch(/is a symlink to/);
      expect(existsSync(join(real, "audit-loaders/SKILL.md"))).toBe(false);

      // Still inside the project, so --force is an informed choice.
      const forced = await runCli(
        ["skills", "add", "audit-loaders", "--index", indexUrl, "--force"],
        { cwd: appDir },
      );
      expect(forced.status).toBe(0);
      expect(readFileSync(join(real, "audit-loaders/SKILL.md"), "utf-8")).toBe(SKILL_A);
    });
  });

  // Vetting `.claude/skills` alone left the level below it open: a symlink at
  // `.claude/skills/<name>` is followed by `writeFileSync` just the same.
  it("refuses a skill directory symlinked outside the project", async () => {
    const appDir = createTempDir("pracht-cli-skills-inner-link-");
    const outside = createTempDir("pracht-cli-skills-inner-outside-");
    mkdirSync(join(appDir, ".claude/skills"), { recursive: true });
    symlinkSync(outside, join(appDir, ".claude/skills/audit-loaders"));

    await withIndex({ entries: goodEntries, bodies: goodBodies }, async ({ indexUrl }) => {
      const result = await runCli(
        ["skills", "add", "audit-loaders", "--index", indexUrl, "--force", "--json"],
        { cwd: appDir },
      );

      expect(result.status).toBe(1);
      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(false);
      expect(output.failed[0].error).toMatch(/outside/);
      expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
    });
  });

  // The link's target need not exist, so `existsSync` never sees it and the
  // "already installed" check cannot be what guards this.
  it("refuses a skill directory that is a dangling symlink out of the project", async () => {
    const appDir = createTempDir("pracht-cli-skills-dangling-");
    const outside = createTempDir("pracht-cli-skills-dangling-outside-");
    mkdirSync(join(appDir, ".claude/skills"), { recursive: true });
    symlinkSync(join(outside, "not-yet"), join(appDir, ".claude/skills/audit-loaders"));

    await withIndex({ entries: goodEntries, bodies: goodBodies }, async ({ indexUrl }) => {
      const result = await runCli(["skills", "add", "audit-loaders", "--index", indexUrl], {
        cwd: appDir,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/outside/);
      expect(existsSync(join(outside, "not-yet"))).toBe(false);
    });
  });

  it("refuses a SKILL.md symlinked outside the project", async () => {
    const appDir = createTempDir("pracht-cli-skills-file-link-");
    const outside = createTempDir("pracht-cli-skills-file-outside-");
    mkdirSync(join(appDir, ".claude/skills/audit-loaders"), { recursive: true });
    symlinkSync(join(outside, "SKILL.md"), skillFile(appDir, "audit-loaders"));

    await withIndex({ entries: goodEntries, bodies: goodBodies }, async ({ indexUrl }) => {
      const result = await runCli(
        ["skills", "add", "audit-loaders", "--index", indexUrl, "--force"],
        { cwd: appDir },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/outside/);
      expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
    });
  });

  // Whatever went wrong, a caller piping stdout through a parser gets one shape.
  it("emits the same --json envelope for a fatal error", async () => {
    const appDir = createTempDir("pracht-cli-skills-json-shape-");

    const result = await runCli(
      ["skills", "add", "audit-loaders", "--index", "http://example.com/index.json", "--json"],
      { cwd: appDir },
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: expect.stringMatching(/must use https/),
      installed: [],
      skipped: [],
      failed: [],
    });
    expect(result.stderr).toBe("");
  });

  it("emits the same --json envelope when list fails", async () => {
    const appDir = createTempDir("pracht-cli-skills-json-list-");

    const result = await runCli(
      ["skills", "list", "--index", "http://example.com/index.json", "--json"],
      { cwd: appDir },
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: expect.stringMatching(/must use https/),
      skills: [],
    });
  });

  it("refuses a .claude/skills symlink that escapes the project even with --force", async () => {
    const appDir = createTempDir("pracht-cli-skills-escape-");
    const outside = createTempDir("pracht-cli-skills-outside-");
    mkdirSync(join(appDir, ".claude"), { recursive: true });
    symlinkSync(outside, join(appDir, ".claude/skills"));

    await withIndex({ entries: goodEntries, bodies: goodBodies }, async ({ indexUrl }) => {
      const result = await runCli(
        ["skills", "add", "audit-loaders", "--index", indexUrl, "--force"],
        { cwd: appDir },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/outside/);
      expect(existsSync(join(outside, "audit-loaders/SKILL.md"))).toBe(false);
    });
  });
});
