import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AGENT_SKILLS_SCHEMA, generateAgentSkillArtifacts } from "../src/agent-skills.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createRoot(skills: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-agent-skills-"));
  roots.push(root);
  for (const [name, source] of Object.entries(skills)) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(join(root, "skills", name, "SKILL.md"), source, "utf8");
  }
  return root;
}

describe("generateAgentSkillArtifacts", () => {
  it("emits deterministic skill assets and a v0.2 digest index", () => {
    const review = `---\nname: review-code\ndescription: Review code carefully.\n---\n\n# Review\n`;
    const deploy = `---\nname: deploy-app\ndescription: |\n  Deploy the app safely.\n  Use when publishing.\n---\n\n# Deploy\n`;
    const artifacts = generateAgentSkillArtifacts(
      createRoot({ "review-code": review, "deploy-app": deploy }),
      {
        directory: "./skills",
        manifest: { name: "example", homepage: "https://example.com" },
        advertise: true,
      },
    );

    expect(artifacts.map((artifact) => artifact.outputPath)).toEqual([
      "skills/deploy-app/SKILL.md",
      "skills/review-code/SKILL.md",
      ".well-known/agent-skills/index.json",
    ]);
    const index = JSON.parse(artifacts.at(-1)!.content);
    expect(index).toEqual({
      $schema: AGENT_SKILLS_SCHEMA,
      name: "example",
      homepage: "https://example.com",
      skills: [
        {
          name: "deploy-app",
          type: "skill-md",
          description: "Deploy the app safely.\nUse when publishing.",
          url: "/skills/deploy-app/SKILL.md",
          digest: `sha256:${createHash("sha256").update(deploy).digest("hex")}`,
        },
        {
          name: "review-code",
          type: "skill-md",
          description: "Review code carefully.",
          url: "/skills/review-code/SKILL.md",
          digest: `sha256:${createHash("sha256").update(review).digest("hex")}`,
        },
      ],
    });
  });

  it("fails when frontmatter identity does not match the directory", () => {
    const root = createRoot({ wrong: "---\nname: right\ndescription: Test.\n---\n" });
    expect(() =>
      generateAgentSkillArtifacts(root, {
        directory: "./skills",
        manifest: { name: "example" },
      }),
    ).toThrow(/must match its parent directory/);
  });

  it("parses YAML block scalar modifiers and quoted values", () => {
    const source = `---
name: review-code
description: >-
  Review "code" carefully.
  Use when auditing changes.
---

# Review
`;
    const artifacts = generateAgentSkillArtifacts(createRoot({ "review-code": source }), {
      directory: "./skills",
      manifest: { name: "example" },
    });

    expect(JSON.parse(artifacts.at(-1)!.content).skills[0].description).toBe(
      'Review "code" carefully. Use when auditing changes.',
    );
  });

  it("rejects non-string or malformed YAML metadata", () => {
    const nonString = createRoot({
      "review-code": "---\nname: review-code\ndescription: [review, code]\n---\n",
    });
    expect(() =>
      generateAgentSkillArtifacts(nonString, {
        directory: "./skills",
        manifest: { name: "example" },
      }),
    ).toThrow(/string "name" and "description"/);

    const malformed = createRoot({
      "review-code": "---\nname: review-code\ndescription: [unterminated\n---\n",
    });
    expect(() =>
      generateAgentSkillArtifacts(malformed, {
        directory: "./skills",
        manifest: { name: "example" },
      }),
    ).toThrow(/invalid YAML frontmatter/);
  });
});
