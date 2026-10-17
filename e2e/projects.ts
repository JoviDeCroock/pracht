import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Which Playwright project (and so which dev server) runs each spec in e2e/.
// Names are spec basenames without `.test.ts`. A spec that is in no list is
// never run, so `assertE2ESpecsAssigned()` refuses to start the suite when a
// spec is missing, listed twice, or listed but deleted.
export const e2eProjectSpecs = {
  basic: [
    "basic",
    "client-bundle-strip",
    "cloudflare-build",
    "env-safety",
    "hydration-probe",
    "islands-build",
    "islands-navigation-build",
    "navigation",
    "netlify-build",
    "node-build",
    "not-found",
    "openapi-cloudflare-dev",
    "pages-isg-build",
    "shell-data",
    "static-404-hydration",
    "static-build",
    "tsrx-build",
    "vercel-build",
  ],
  "pages-router": ["dev-404", "llms-txt-dev", "openapi-dev", "pages-router"],
  islands: ["edge-route-css", "islands-css-parity", "islands-dev"],
  "server-islands": ["server-islands-dev"],
  capabilities: ["capabilities", "dev-page-tools", "i18n", "markdown-files-dev", "search-params"],
} as const satisfies Record<string, readonly string[]>;

export type E2EProjectName = keyof typeof e2eProjectSpecs;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A `testMatch` that matches exactly the named specs, by whole basename. */
export function specsMatcher(project: E2EProjectName): RegExp {
  const names = e2eProjectSpecs[project].map(escapeRegExp).join("|");
  return new RegExp(`(?:^|[\\\\/])(?:${names})\\.test\\.ts$`);
}

// Playwright's default `testMatch`: anything it would treat as a spec file.
const SPEC_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/;

function listSpecFiles(dir: string, root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSpecFiles(path, root));
    } else if (SPEC_FILE.test(entry.name)) {
      files.push(relative(root, path).split("\\").join("/"));
    }
  }
  return files.sort();
}

/** Every problem with the spec-to-project assignment, one message each. */
export function findE2ESpecAssignmentProblems(e2eDir: string): string[] {
  const problems: string[] = [];
  const specFiles = listSpecFiles(e2eDir, e2eDir);
  const projects = Object.keys(e2eProjectSpecs) as E2EProjectName[];

  for (const file of specFiles) {
    const owners = projects.filter((project) => specsMatcher(project).test(`/${file}`));
    if (owners.length === 0) {
      problems.push(`e2e/${file} is in no project, so it would never run`);
    } else if (owners.length > 1) {
      problems.push(`e2e/${file} is in more than one project: ${owners.join(", ")}`);
    }
  }

  for (const project of projects) {
    for (const name of e2eProjectSpecs[project]) {
      if (!specFiles.includes(`${name}.test.ts`)) {
        problems.push(`project "${project}" lists e2e/${name}.test.ts, which does not exist`);
      }
    }
  }

  return problems;
}

export function assertE2ESpecsAssigned(e2eDir: string): void {
  const problems = findE2ESpecAssignmentProblems(e2eDir);
  if (problems.length > 0) {
    throw new Error(
      `Every e2e spec must belong to exactly one project in e2e/projects.ts:\n` +
        problems.map((problem) => `  - ${problem}`).join("\n"),
    );
  }
}
