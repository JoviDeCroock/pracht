#!/usr/bin/env node

/**
 * Copies the repo-local agent skills (skills/<name>/SKILL.md) into this
 * package so the published npm tarball can seed them into scaffolded apps.
 * Runs as the package build step; the copied directory is gitignored.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = resolve(packageRoot, "../../skills");
const targetDir = join(packageRoot, "skills");

if (!existsSync(sourceDir)) {
  console.error(`sync-skills: missing source directory ${sourceDir}`);
  process.exit(1);
}

rmSync(targetDir, { force: true, recursive: true });

let copied = 0;
for (const name of readdirSync(sourceDir)) {
  const skillFile = join(sourceDir, name, "SKILL.md");
  if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
    continue;
  }
  mkdirSync(join(targetDir, name), { recursive: true });
  copyFileSync(skillFile, join(targetDir, name, "SKILL.md"));
  copied += 1;
}

console.log(`sync-skills: copied ${copied} skills into packages/start/skills`);
