import { spawn } from "node:child_process";

export async function initGitRepository(targetDir) {
  if (!(await execCommand("git", ["--version"]))) {
    return { initialized: false, reason: "git-not-found" };
  }
  if (await execCommand("git", ["rev-parse", "--is-inside-work-tree"], targetDir)) {
    return { initialized: false, reason: "existing-repo" };
  }
  if (!(await execCommand("git", ["init"], targetDir))) {
    return { initialized: false, reason: "init-failed" };
  }
  if (!(await execCommand("git", ["add", "-A"], targetDir))) {
    return { initialized: false, reason: "commit-failed" };
  }

  // Use a scoped identity when the user has no git identity configured so a
  // fresh machine or CI environment can still create the initial commit.
  const hasIdentity = await execCommand("git", ["config", "user.email"], targetDir);
  const identityArgs = hasIdentity
    ? []
    : ["-c", "user.name=create-pracht", "-c", "user.email=create-pracht@localhost"];
  const committed = await execCommand(
    "git",
    [...identityArgs, "commit", "-m", "Initial commit from create-pracht"],
    targetDir,
  );

  return committed ? { initialized: true } : { initialized: false, reason: "commit-failed" };
}

export async function installDependencies(targetDir, packageManager) {
  return await new Promise((resolveInstall) => {
    const child = spawn(packageManager, ["install"], {
      cwd: targetDir,
      stdio: "inherit",
    });
    child.on("close", (code) => resolveInstall(code === 0));
    child.on("error", () => resolveInstall(false));
  });
}

function execCommand(command, args, cwd) {
  return new Promise((resolveExec) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.on("close", (code) => resolveExec(code === 0));
    child.on("error", () => resolveExec(false));
  });
}
