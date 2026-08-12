export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 2;
  }
}

export function getPackageManager(userAgent = process.env.npm_config_user_agent ?? "") {
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("bun") || process.versions.bun) return "bun";
  return "npm";
}

export function getPnpmMajor(userAgent = process.env.npm_config_user_agent ?? "") {
  const match = /^pnpm\/(\d+)/.exec(userAgent);
  return match ? Number(match[1]) : 11;
}

export function normalizeTemplate(value) {
  const normalized = value.toLowerCase();
  return normalized === "minimal" || normalized === "tailwind" ? normalized : null;
}

export function normalizeRouter(value) {
  const normalized = value.toLowerCase();
  if (normalized === "1" || normalized === "manifest") return "manifest";
  if (normalized === "2" || normalized === "pages") return "pages";
  return null;
}

export function normalizeAdapter(value) {
  const normalized = value.toLowerCase();
  if (normalized === "1" || normalized === "node") return "node";
  if (
    normalized === "2" ||
    normalized === "cf" ||
    normalized === "cloudflare" ||
    normalized === "cloudflare-workers"
  ) {
    return "cloudflare";
  }
  if (normalized === "3" || normalized === "vc" || normalized === "vercel") return "vercel";
  if (normalized === "4" || normalized === "nf" || normalized === "netlify") return "netlify";
  return null;
}

export function parseArgs(argv) {
  const options = {
    adapter: undefined,
    agentTools: undefined,
    dir: undefined,
    dryRun: false,
    git: true,
    json: false,
    router: undefined,
    skipInstall: false,
    tailwind: undefined,
    yes: false,
  };

  for (const arg of argv) {
    if (arg === "--skip-install") {
      options.skipInstall = true;
      continue;
    }
    if (arg === "--tailwind") {
      options.tailwind = true;
      continue;
    }
    if (arg === "--no-tailwind") {
      options.tailwind = false;
      continue;
    }
    if (arg === "--no-git") {
      options.git = false;
      continue;
    }
    if (arg === "--agent-tools") {
      options.agentTools = true;
      continue;
    }
    if (arg === "--no-agent-tools") {
      options.agentTools = false;
      continue;
    }
    if (arg.startsWith("--template=")) {
      const rawValue = arg.slice("--template=".length);
      const value = normalizeTemplate(rawValue);
      if (!value) {
        throw new ValidationError(`Invalid template: ${rawValue}. Use minimal or tailwind.`);
      }
      options.tailwind = value === "tailwind";
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg.startsWith("--adapter=")) {
      const rawValue = arg.slice("--adapter=".length);
      const value = normalizeAdapter(rawValue);
      if (!value) {
        throw new ValidationError(`Invalid adapter: ${rawValue}. Use node, cf, netlify, or vercel.`);
      }
      options.adapter = value;
      continue;
    }
    if (arg.startsWith("--router=")) {
      const rawValue = arg.slice("--router=".length);
      const value = normalizeRouter(rawValue);
      if (!value) {
        throw new ValidationError(`Invalid router: ${rawValue}. Use manifest or pages.`);
      }
      options.router = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (!arg.startsWith("-") && !options.dir) {
      options.dir = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log(`create-pracht

Usage:
  create-pracht [directory] [options]

Options:
  --adapter=node|cf|netlify|vercel
                               Choose hosting adapter (default: node)
  --router=manifest|pages      Choose routing system (default: manifest)
  --template=minimal|tailwind  Choose starter template (minimal, or minimal + Tailwind CSS)
  --tailwind / --no-tailwind   Enable or disable Tailwind CSS wiring (default: prompt).
                               Sets the same thing as --template; the last one wins.
  --agent-tools / --no-agent-tools
                               Seed Claude Code skills and a pracht MCP config (default: prompt, yes)
  --no-git                     Skip git init and the initial commit
  --skip-install               Skip dependency installation
  --yes, -y                    Accept defaults, skip all prompts
  --json                       Output JSON summary instead of prose
  --dry-run                    Show which files would be created without writing
  -h, --help                   Show this help message
`);
}
