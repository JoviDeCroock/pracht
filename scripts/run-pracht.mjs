#!/usr/bin/env node
/**
 * Cross-platform environment setup for repository example scripts.
 *
 * Usage:
 *   node scripts/run-pracht.mjs NAME=value NAME?=fallback -- command [...args]
 *
 * `?=` preserves a caller-supplied value. The pracht CLI is imported directly,
 * avoiding POSIX-only inline assignments and Windows `.cmd` spawning concerns.
 */

const args = process.argv.slice(2);
const separator = args.indexOf("--");

if (separator === -1 || separator === args.length - 1) {
  throw new Error("Usage: run-pracht.mjs [NAME=value|NAME?=fallback ...] -- command [...args]");
}

for (const assignment of args.slice(0, separator)) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?=(.*)$/s.exec(assignment);
  if (!match) {
    throw new Error(`Invalid environment assignment: ${assignment}`);
  }

  const [, name, defaultOnly, value] = match;
  if (!defaultOnly || process.env[name] === undefined || process.env[name] === "") {
    process.env[name] = value;
  }
}

process.argv = [process.execPath, "pracht", ...args.slice(separator + 1)];
await import("../packages/cli/dist/index.mjs");
