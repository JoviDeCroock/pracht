import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { ADAPTERS, DEFAULT_DIRECTORY } from "./config.js";
import { getPackageManager, getPnpmMajor, parseArgs } from "./options.js";
import {
  ensureTargetDirectory,
  promptForAdapter,
  promptForAgentTools,
  promptForDirectory,
  promptForRouter,
  promptForTailwind,
} from "./prompts.js";
import { initGitRepository, installDependencies } from "./child-process.js";
import { buildProjectFiles, scaffoldProject, toPackageName } from "./scaffold.js";

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const packageManagerUserAgent = process.env.npm_config_user_agent ?? "";
  const packageManager = getPackageManager(packageManagerUserAgent);
  const pnpmMajor = packageManager === "pnpm" ? getPnpmMajor(packageManagerUserAgent) : null;
  const log = options.json ? () => {} : console.log.bind(console);

  log("create-pracht");
  log(`Using ${packageManager} for this scaffold.`);
  log("");

  const selected = await resolveSelections(options);
  const targetDir = resolve(process.cwd(), selected.dir);
  await ensureTargetDirectory(targetDir);

  if (options.dryRun) {
    const files = await listProjectFiles({
      ...selected,
      packageManager,
      pnpmMajor,
      targetDir,
    });
    if (options.json) {
      console.log(
        JSON.stringify({
          adapter: selected.adapter,
          agentTools: selected.agentTools,
          directory: selected.dir,
          dryRun: true,
          files,
          router: selected.router,
          tailwind: selected.tailwind,
        }),
      );
    } else {
      log("Dry run — the following files would be created:");
      log("");
      for (const file of files) log(`  ${file}`);
    }
    return;
  }

  const adapter = ADAPTERS[selected.adapter];
  const { pnpmWorkspaceNotice } = await scaffoldProject({
    adapter,
    agentTools: selected.agentTools,
    packageManager,
    pnpmMajor,
    router: selected.router,
    tailwind: selected.tailwind,
    targetDir,
  });

  let installSucceeded = false;
  if (!options.skipInstall) {
    log("");
    log(`Installing dependencies with ${packageManager}...`);
    installSucceeded = await installDependencies(targetDir, packageManager);
  }

  let gitInitialized = false;
  if (options.git) {
    const gitResult = await initGitRepository(targetDir);
    gitInitialized = gitResult.initialized;
    printGitResult(gitResult, log);
  }

  if (options.json) {
    const files = await listProjectFiles({
      ...selected,
      packageManager,
      pnpmMajor,
      targetDir,
    });
    console.log(
      JSON.stringify({
        adapter: selected.adapter,
        agentTools: selected.agentTools,
        directory: selected.dir,
        files,
        gitInitialized,
        installed: options.skipInstall ? false : installSucceeded,
        pnpmWorkspaceNotice,
        router: selected.router,
        tailwind: selected.tailwind,
      }),
    );
    return;
  }

  printNextSteps({
    adapter,
    agentTools: selected.agentTools,
    dir: selected.dir,
    installSucceeded,
    packageManager,
    pnpmWorkspaceNotice,
    router: selected.router,
    skipInstall: options.skipInstall,
    tailwind: selected.tailwind,
  });
}

async function resolveSelections(options) {
  const selections = {
    dir: options.dir ?? (options.yes ? DEFAULT_DIRECTORY : null),
    adapter: options.adapter ?? (options.yes ? "node" : null),
    router: options.router ?? (options.yes ? "manifest" : null),
    tailwind: options.tailwind ?? (options.yes ? false : null),
    agentTools: options.agentTools ?? (options.yes ? true : null),
  };

  if (Object.values(selections).every((value) => value != null)) return selections;

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    selections.dir = selections.dir ?? (await promptForDirectory(readline));
    selections.adapter = selections.adapter ?? (await promptForAdapter(readline));
    selections.router = selections.router ?? (await promptForRouter(readline));
    selections.tailwind = selections.tailwind ?? (await promptForTailwind(readline));
    selections.agentTools = selections.agentTools ?? (await promptForAgentTools(readline));
  } finally {
    readline.close();
  }
  return selections;
}

async function listProjectFiles({
  adapter,
  agentTools,
  packageManager,
  pnpmMajor,
  router,
  tailwind,
  targetDir,
}) {
  const { files } = await buildProjectFiles({
    adapter: ADAPTERS[adapter],
    agentTools,
    packageManager,
    pnpmMajor,
    projectName: toPackageName(basename(targetDir)),
    resolveRemoteVersions: false,
    router,
    tailwind,
    targetDir,
  });
  return Object.keys(files).sort();
}

function printGitResult(result, log) {
  if (result.initialized) {
    log("");
    log("Initialized a git repository with an initial commit.");
  } else if (result.reason === "existing-repo") {
    log("");
    log("Skipped git init — the target directory is already inside a git repository.");
  } else if (result.reason === "git-not-found") {
    log("");
    log("Skipped git init — git is not available on this machine.");
  }
}

function printNextSteps({
  adapter,
  agentTools,
  dir,
  installSucceeded,
  packageManager,
  pnpmWorkspaceNotice,
  router,
  skipInstall,
  tailwind,
}) {
  const installCommand = packageManager === "npm" ? "npm install" : `${packageManager} install`;
  const devCommand = packageManager === "npm" ? "npm run dev" : `${packageManager} dev`;

  console.log("");
  console.log(`Created a pracht app in ${dir}.`);
  console.log(`Adapter: ${adapter.label}`);
  console.log(
    `Router:  ${router === "pages" ? "pages (file-system)" : "manifest (src/routes.ts)"}`,
  );
  console.log(`Tailwind: ${tailwind ? "yes" : "no"}`);
  console.log(`Agent tooling: ${agentTools ? "skills, .mcp.json, AGENTS.md" : "none"}`);
  if (router === "pages") {
    console.log("");
    console.log(
      "Note: the pages router has no manifest, so middleware, capabilities, constraints, and\n" +
        "the agent surface (capability endpoints, WebMCP, remote MCP, `pracht eval`) are not\n" +
        "available. Scaffold with --router=manifest if you need them.",
    );
  }
  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${dir}`);
  if (skipInstall || !installSucceeded) console.log(`  ${installCommand}`);
  console.log(`  ${devCommand}`);

  if (!skipInstall && !installSucceeded) {
    console.log("");
    console.log("Dependency installation did not complete. The project files were still created.");
  }

  if (pnpmWorkspaceNotice) printPnpmWorkspaceNotice(pnpmWorkspaceNotice);
}

function printPnpmWorkspaceNotice(notice) {
  console.log("");
  console.log(
    `This app is inside the pnpm workspace at ${notice.root}, which owns build\n` +
      "permissions for every package. Add the following to its pnpm-workspace.yaml, or\n" +
      "the starter's required dependency install scripts will not run:",
  );
  console.log("");
  console.log(`  ${notice.policy}:`);
  for (const name of notice.packages) {
    console.log(
      notice.policy === "onlyBuiltDependencies"
        ? `    - ${JSON.stringify(name)}`
        : `    ${JSON.stringify(name)}: true`,
    );
  }
}
