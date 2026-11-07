/**
 * Package-manager variants for shell code blocks. Pages are written with pnpm;
 * the Markdown compiler (`content.ts`) turns each eligible block into one
 * block per manager, and the `DocsEnhancer` island switches between them.
 * The `.md` sources and llms.txt keep the pnpm original.
 */

export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const PNPM_LINE = /^(\s*)pnpm\s+(\S+)(.*)$/;

/** Binaries pnpm runs directly (`pnpm pracht inspect`); other managers need `npx`/`bunx`. */
const BINARIES = new Set(["pracht", "playwright", "tsx", "vite", "vitest", "wrangler", "vercel"]);

/**
 * Commands only a clone of the pracht repository runs; that workspace needs
 * pnpm, so those blocks stay as they are.
 */
const REPO_ONLY = /git clone|\bcd examples\/|\bpnpm bench\b/;

/** True when a shell block should get package-manager variants. */
export function hasPackageManagerVariants(code: string): boolean {
  if (REPO_ONLY.test(code)) return false;
  const lines = code.split("\n");
  // A block that already spells out other managers is left alone.
  if (lines.some((line) => /^\s*(npm|npx|yarn|bun|bunx)\s/.test(line))) return false;
  return lines.some((line) => PNPM_LINE.test(line));
}

function words(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean);
}

/** One `pnpm …` command (no `&&`, no comment) in another manager's syntax. */
function convertCommand(command: string, manager: PackageManager): string {
  const match = /^pnpm\s+(\S+)(.*)$/.exec(command.trim());
  if (!match || manager === "pnpm") return command;
  const [, verb, rest] = match;
  const args = words(rest);
  const tail = args.length > 0 ? ` ${args.join(" ")}` : "";
  if (BINARIES.has(verb)) return convertCommand(`pnpm exec ${verb}${tail}`, manager);

  switch (verb) {
    case "add": {
      const dev = args.some((arg) => arg === "-D" || arg === "--save-dev");
      const packages = args.filter((arg) => arg !== "-D" && arg !== "--save-dev").join(" ");
      if (manager === "npm") return `npm install${dev ? " -D" : ""} ${packages}`;
      if (manager === "yarn") return `yarn add${dev ? " -D" : ""} ${packages}`;
      return `bun add${dev ? " --dev" : ""} ${packages}`;
    }
    case "install":
    case "i":
      return `${manager} install${tail}`;
    case "remove":
    case "rm":
      return manager === "npm" ? `npm uninstall${tail}` : `${manager} remove${tail}`;
    case "up":
    case "update":
      if (manager === "yarn") return `yarn up${tail}`;
      return `${manager} update${tail}`;
    case "create": {
      const [name = "", ...more] = args;
      if (manager === "bun") return `bunx create-${name}${more.length ? ` ${more.join(" ")}` : ""}`;
      if (manager === "yarn") return `yarn create ${args.join(" ")}`;
      // npm forwards flags to the initializer only after `--`.
      const positional = more.filter((arg) => !arg.startsWith("-"));
      const flags = more.filter((arg) => arg.startsWith("-"));
      return [`npm create ${name}@latest`, ...positional, ...(flags.length ? ["--", ...flags] : [])]
        .join(" ")
        .trim();
    }
    case "dlx":
      if (manager === "npm") return `npx${tail}`;
      if (manager === "yarn") return `yarn dlx${tail}`;
      return `bunx${tail}`;
    case "exec":
      if (manager === "npm") return `npx${tail}`;
      if (manager === "yarn") return `yarn${tail}`;
      return `bunx${tail}`;
    case "run": {
      const [script = "", ...more] = args;
      const extra = more.length ? ` ${more.join(" ")}` : "";
      if (manager === "yarn") return `yarn ${script}${extra}`;
      if (manager === "npm")
        return `npm run ${script}${more.length ? ` -- ${more.join(" ")}` : ""}`;
      return `bun run ${script}${extra}`;
    }
    default:
      // `pnpm dev`, `pnpm build`, … run a package.json script.
      if (manager === "yarn") return `yarn ${verb}${tail}`;
      if (manager === "npm") return `npm run ${verb}${args.length ? ` -- ${args.join(" ")}` : ""}`;
      return `bun run ${verb}${tail}`;
  }
}

/** A whole shell block in another manager's syntax; non-pnpm lines are kept. */
export function convertShell(code: string, manager: PackageManager): string {
  if (manager === "pnpm") return code;
  return code
    .split("\n")
    .map((line) => {
      if (!PNPM_LINE.test(line)) return line;
      const indent = /^\s*/.exec(line)![0];
      const hash = line.indexOf(" #");
      const command = hash === -1 ? line : line.slice(0, hash);
      const comment = hash === -1 ? "" : line.slice(hash);
      const converted = command
        .trim()
        .split(/\s*&&\s*/)
        .map((part) => (part.startsWith("pnpm ") ? convertCommand(part, manager) : part))
        .join(" && ");
      // Keep trailing comments aligned when the command changed length.
      return `${indent}${converted}${comment ? ` ${comment.trimStart()}` : ""}`;
    })
    .join("\n");
}
