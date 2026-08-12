import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { SKILL_DIRS } from "./config.js";

export async function buildAgentToolFiles() {
  return {
    ".mcp.json": createMcpConfig(),
    ...(await readSkillFiles()),
  };
}

function createMcpConfig() {
  return `${JSON.stringify(
    {
      mcpServers: {
        pracht: {
          command: "npx",
          // `--no-install` pins this to the `@pracht/cli` the project depends
          // on. `--yes @pracht/cli` fetched the registry's latest instead, so
          // the MCP server an agent talked to could describe a different CLI
          // than the one the app builds with. Not bare `npx pracht` either:
          // that resolves to a registry package literally named `pracht`
          // whenever the local bin is missing — `--no-install` fails loudly.
          args: ["--no-install", "pracht", "mcp"],
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function readSkillFiles() {
  const skillsDir = SKILL_DIRS.find((dir) => existsSync(dir));
  if (!skillsDir) return {};

  const files = {};
  for (const name of await readdir(skillsDir)) {
    const skillFile = resolve(skillsDir, name, "SKILL.md");
    if (existsSync(skillFile)) {
      files[`.claude/skills/${name}/SKILL.md`] = await readFile(skillFile, "utf-8");
    }
  }
  return files;
}
