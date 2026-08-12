import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_DIRECTORY } from "./config.js";
import { ValidationError, normalizeAdapter, normalizeRouter } from "./options.js";

export async function promptForDirectory(readline) {
  while (true) {
    const answer = await readline.question(`Project directory (${DEFAULT_DIRECTORY}): `);
    const dir = answer.trim() || DEFAULT_DIRECTORY;
    const error = await validateTargetDirectory(resolve(process.cwd(), dir));
    if (!error) return dir;
    console.log(error);
  }
}

export async function promptForAdapter(readline) {
  console.log("Adapters:");
  console.log("  1. Node.js");
  console.log("  2. Cloudflare Workers");
  console.log("  3. Vercel");
  console.log("  4. Netlify");

  while (true) {
    const normalized = normalizeAdapter((await readline.question("Adapter (1): ")).trim() || "1");
    if (normalized) return normalized;
    console.log("Choose 1/2/3/4 or node/cf/vercel/netlify.");
  }
}

export async function promptForRouter(readline) {
  console.log("Router:");
  console.log("  1. Manifest (explicit routes.ts) — supports middleware, capabilities,");
  console.log("     MCP, Web Bot Auth, and constraints");
  console.log("  2. Pages (file-system routing) — pages and API routes only; no");
  console.log("     middleware, capabilities, MCP, or agent trust (eject later to add them)");

  while (true) {
    const normalized = normalizeRouter((await readline.question("Router (1): ")).trim() || "1");
    if (normalized) return normalized;
    console.log("Choose 1/2 or manifest/pages.");
  }
}

export async function promptForTailwind(readline) {
  return promptForYesNo(readline, "Use Tailwind CSS? (y/N): ", false);
}

export async function promptForAgentTools(readline) {
  return promptForYesNo(readline, "Set up Claude Code skills + MCP? (Y/n): ", true);
}

export async function ensureTargetDirectory(targetDir) {
  const error = await validateTargetDirectory(targetDir);
  if (error) throw new ValidationError(error);
}

async function promptForYesNo(readline, question, defaultValue) {
  while (true) {
    const answer = (await readline.question(question)).trim();
    const normalized = normalizeYesNo(answer || (defaultValue ? "yes" : "no"));
    if (normalized != null) return normalized;
    console.log("Answer y/yes or n/no.");
  }
}

function normalizeYesNo(value) {
  const normalized = value.toLowerCase();
  if (normalized === "y" || normalized === "yes") return true;
  if (normalized === "n" || normalized === "no") return false;
  return null;
}

async function validateTargetDirectory(targetDir) {
  if (!existsSync(targetDir)) return null;
  const targetStat = await stat(targetDir);
  if (!targetStat.isDirectory()) return "Target path already exists and is not a directory.";
  const entries = await readdir(targetDir);
  return entries.length > 0 ? "Target directory already exists and is not empty." : null;
}
