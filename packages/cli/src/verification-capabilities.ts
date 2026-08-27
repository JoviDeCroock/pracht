import {
  dirname,
  isAbsolute as isAbsolutePath,
  relative as relativePath,
  resolve,
} from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import {
  collectInvalidSchemaKeywordValues,
  collectUnsupportedSchemaKeywords,
  findMcpToolNameCollisions,
  isValidCapabilityHttpPath,
  isValidMcpToolName,
  MCP_SCHEMA_ROOT_ERROR,
  MCP_TOOL_NAME_ERROR,
  mcpToolName,
} from "@pracht/capabilities";
import {
  evaluateLiteral,
  extractCapabilityRegistrations,
  extractDefineAppObjectBody,
  extractDefineCapabilityArgs,
  findTopLevelObjectProperty,
  maskCommentsAndStrings,
  scanTopLevelProperties,
} from "@pracht/capabilities/static";
import { isValidOAuthScopeToken, OAUTH_PROTECTED_RESOURCE_WELL_KNOWN } from "@pracht/core";

import { extractRegistryEntries } from "./manifest.js";
import { resolveProjectPath, type ProjectConfig } from "./project.js";
import { createCheck, type Check } from "./verification-helpers.js";

const CAPABILITY_EFFECTS = new Set(["read", "write", "destructive"]);
const AGENT_POLICIES = new Set(["observe", "require"]);

/**
 * Static verification of registered capabilities (manifest mode only). These
 * checks mirror what `defineCapability()` and the runtime registry enforce,
 * but run without executing application code so `pracht verify` stays fast
 * and safe. Spec security rule 1: exposed capabilities without a full
 * contract (description, input, output, effect) fail verification. Spec rule
 * 3: destructive capabilities may only be exposed over HTTP and remote MCP,
 * and only when the prepare/commit confirmation secret
 * (PRACHT_CONFIRMATION_SECRET) is configured in the environment `pracht verify`
 * runs in — MCP additionally needs the `agents.mcp.destructive` opt-in and a
 * registered approval store.
 */
export function collectCapabilityChecks(project: ProjectConfig, checks: Check[]): void {
  const manifestPath = resolveProjectPath(project.root, project.appFile);
  if (!existsSync(manifestPath)) return;

  const manifestSource = readFileSync(manifestPath, "utf-8");
  const entries = extractCapabilityRegistrations(manifestSource).map(({ name, file }) => ({
    name,
    path: file,
  }));
  // Runs before the early return: an app can protect its MCP endpoint while
  // its capabilities live behind a manifest shape this analyzer cannot read.
  collectMcpAuthChecks(project, manifestPath, manifestSource, checks);
  if (entries.length === 0) return;
  const registeredMiddleware = new Set(
    extractRegistryEntries(manifestSource, "middleware").map((entry) => entry.name),
  );

  checks.push(
    createCheck(
      "ok",
      `Registered ${entries.length} capabilit${entries.length === 1 ? "y" : "ies"}.`,
    ),
  );

  const manifestDir = dirname(manifestPath);
  const httpExposedNames: string[] = [];
  const mcpExposed: string[] = [];
  const destructiveMcpExposed: string[] = [];
  const projection = readMcpProjectionConfig(manifestSource);
  for (const entry of entries) {
    // Root-relative refs ("/src/capabilities/x.ts") resolve against the project
    // root, matching the runtime registry and the Vite plugin; everything else
    // is relative to the manifest. Resolving them all against the manifest
    // directory would leave every root-relative capability unverified.
    const rootRelative = entry.path.startsWith("/");
    const filePath = rootRelative
      ? resolveProjectPath(project.root, entry.path)
      : resolve(manifestDir, entry.path);
    if (!existsSync(filePath)) {
      // The manifest check only reports missing "./"-relative references, so
      // root-relative ones have to be reported here or they pass silently.
      if (rootRelative) {
        checks.push(
          createCheck(
            "error",
            `Capability ${JSON.stringify(entry.name)} references missing file ${JSON.stringify(entry.path)}.`,
          ),
        );
      }
      continue;
    }

    const source = readFileSync(filePath, "utf-8");
    if (hasValidStaticHttpExposure(source)) {
      httpExposedNames.push(entry.name);
    }
    collectSingleCapabilityChecks(entry.name, entry.path, source, registeredMiddleware, checks, {
      mcpExposed,
      destructiveMcpExposed,
      projection,
    });
  }

  collectShadowedNameChecks(httpExposedNames, checks);
  collectMcpProjectionChecks(mcpExposed, projection, checks);
  collectDestructiveMcpChecks(destructiveMcpExposed, projection, project, checks);
}

/**
 * What the manifest source says about `agents.mcp`. Static, so a manifest that
 * assembles its `agents` config elsewhere reads as unconfigured — which is why
 * an unseen projection downgrades to the existing warning instead of failing
 * the build.
 */
interface McpProjectionConfigScan {
  /** `agents: { … mcp: … }` is visible in the manifest source. */
  configured: boolean;
  /** `destructive: true` appears inside the visible `agents.mcp` config. */
  destructive: boolean;
}

function readMcpProjectionConfig(manifestSource: string): McpProjectionConfigScan {
  const appBody = extractDefineAppObjectBody(manifestSource);
  const agentsBody = readInlineObjectBody(
    appBody ? scanTopLevelProperties(appBody).get("agents") : undefined,
  );
  if (agentsBody === null) return { configured: false, destructive: false };

  const mcp = scanTopLevelProperties(agentsBody).get("mcp");
  if (mcp === undefined) return { configured: false, destructive: false };

  const mcpBody = readInlineObjectBody(mcp);
  const destructive =
    mcpBody !== null &&
    evaluateLiteral(scanTopLevelProperties(mcpBody).get("destructive") ?? "") === true;
  return { configured: true, destructive };
}

function readInlineObjectBody(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed.slice(1, -1) : null;
}

/**
 * Destructive tools on the MCP surface are the one exposure that needs state:
 * the confirmation token travels to the same agent that will commit with it, so
 * only a durable approval store makes the commit exactly-once.
 *
 * Both checks here are warnings, deliberately. Neither fact is decidable from
 * source: the manifest may assemble `agents` elsewhere, and the store may be
 * registered by a workspace package this scan never reads. The gate that
 * actually holds is the runtime's — the MCP endpoint refuses to serve a
 * destructive tool when the store, the confirmation secret, or a resolvable
 * principal is missing — so a static grep must report, not hard-block.
 */
function collectDestructiveMcpChecks(
  destructiveMcpExposed: string[],
  projection: McpProjectionConfigScan,
  project: ProjectConfig,
  checks: Check[],
): void {
  if (destructiveMcpExposed.length === 0) return;
  const names = destructiveMcpExposed.map((name) => JSON.stringify(name)).join(", ");

  if (!projection.destructive) {
    // An unseen `agents.mcp` already produced the "nothing serves it" warning.
    if (projection.configured) {
      checks.push(
        createCheck(
          "warning",
          `Capabilities ${names} are destructive and set expose.mcp, but the manifest does not ` +
            "set agents.mcp.destructive — the projection filters them out at serve time. Add " +
            "`agents: { mcp: { destructive: true } }` (with an approval store) or drop expose.mcp.",
        ),
      );
    }
    return;
  }

  const scan = scanForApprovalStore(project);
  if (!scan.found) {
    checks.push(
      createCheck(
        "warning",
        "agents.mcp.destructive is enabled, but no `setCapabilityApprovalStore(` call was found " +
          `in ${scan.searched.join(", ")}. Destructive MCP commits must be exactly-once: ` +
          "register a durable approval store (createSqlApprovalStore from @pracht/core/server) " +
          "from a server-only module, imported by a server entry or a capability module. The " +
          "MCP endpoint refuses to serve destructive tools without one. Ignore this if the " +
          "registration lives outside those directories (a workspace package, say).",
      ),
    );
    return;
  }

  checks.push(
    createCheck(
      "ok",
      `Destructive MCP tools (${names}) are opted in and a setCapabilityApprovalStore() call ` +
        "exists in the scanned source. The runtime still verifies that the module loaded and a " +
        "store is registered before serving them.",
    ),
  );
}

/**
 * Conservative source scan for a store registration, over the directories the
 * project actually configures. It ignores comments and literals, but cannot
 * prove the module is imported — only that source contains a call-shaped
 * registration — which is why its absence is a warning and the runtime fails
 * closed regardless.
 */
function scanForApprovalStore(project: ProjectConfig): { found: boolean; searched: string[] } {
  // Deduplicated because the defaults nest (`/src/server` under `/src`) and a
  // project may point several of these at one directory.
  const configured = [project.serverDir, project.capabilitiesDir, dirname(project.appFile)];
  const searched = [...new Set(configured)];
  for (const dir of searched) {
    const root = resolveProjectPath(project.root, dir);
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry)) continue;
      try {
        const source = maskCommentsAndStrings(readFileSync(resolve(root, entry), "utf-8"));
        if (/\bsetCapabilityApprovalStore\s*\(/.test(source)) {
          return { found: true, searched };
        }
      } catch {
        // Directories and unreadable files are not registrations.
      }
    }
  }
  return { found: false, searched };
}

/**
 * Checks that only make sense across the whole graph: MCP tool names have to
 * be unique, and `expose.mcp` does nothing until the app configures
 * `agents.mcp`.
 */
function collectMcpProjectionChecks(
  mcpExposed: string[],
  projection: McpProjectionConfigScan,
  checks: Check[],
): void {
  if (mcpExposed.length === 0) return;

  for (const collision of findMcpToolNameCollisions(mcpExposed)) {
    checks.push(
      createCheck(
        "error",
        `Capabilities ${collision.capabilities.map((name) => JSON.stringify(name)).join(" and ")} ` +
          `both project to the MCP tool name ${JSON.stringify(collision.toolName)} ` +
          "(dots become underscores). Rename one — the runtime refuses to serve an ambiguous tool list.",
      ),
    );
  }

  if (!projection.configured) {
    checks.push(
      createCheck(
        "warning",
        `${mcpExposed.length} capabilit${mcpExposed.length === 1 ? "y sets" : "ies set"} ` +
          "expose.mcp, but the manifest does not configure agents.mcp — the exposure is recorded " +
          "in the graph and nothing serves it. Add `agents: { mcp: {} }` to defineApp() to serve " +
          "them at /mcp.",
      ),
    );
  }
}

/**
 * Static checks for `agents.mcp.auth` — the OAuth resource-server config.
 *
 * `resolveApp()` validates the same config at build time and throws, but that
 * requires running the app. These checks read the manifest source, so `pracht
 * verify` reports a broken `/mcp` auth setup without a Vite server. Everything
 * this analyzer cannot read stays silent rather than guessing.
 */
function collectMcpAuthChecks(
  project: ProjectConfig,
  manifestPath: string,
  manifestSource: string,
  checks: Check[],
): void {
  const agentsBody = findTopLevelObjectProperty(manifestSource, "agents");
  if (!agentsBody) return;

  // `auth` as a direct key of `agents` reads as protected and is read by
  // nothing — the endpoint stays wide open. Checked via a top-level property
  // scan rather than `findTopLevelObjectProperty`, which searches the whole
  // body and would also find the legitimate `mcp: { auth: … }` nested inside.
  if (scanTopLevelProperties(agentsBody).has("auth")) {
    checks.push(
      createCheck(
        "error",
        "defineApp({ agents.auth }) is not a thing. OAuth resource-server config belongs to the " +
          "remote MCP endpoint: move it to `agents: { mcp: { auth: { … } } }`, which is also " +
          "what enables the endpoint in the first place.",
      ),
    );
  }

  const mcpBody = findTopLevelObjectProperty(agentsBody, "mcp");
  const authBody = mcpBody && findTopLevelObjectProperty(mcpBody, "auth");
  if (!authBody) return;

  // A spread can carry `verify` (or `resource`) in from a shared constant. This
  // analyzer cannot follow it, and a verify *error* on a config that works at
  // runtime is worse than no check at all — so anything unprovable stays quiet.
  const authIsPartlyOpaque = /\.\.\./.test(maskCommentsAndStrings(authBody));
  let authIsProvablyValid = !authIsPartlyOpaque;

  const properties = scanTopLevelProperties(authBody);
  const resourceExpression = properties.get("resource");
  const resource = evaluateLiteral(resourceExpression ?? "");
  if (resourceExpression === undefined && !authIsPartlyOpaque) {
    checks.push(
      createCheck(
        "error",
        "agents.mcp.auth is configured without a `resource` URL. It must identify the remote MCP endpoint's absolute deployed URL.",
      ),
    );
    authIsProvablyValid = false;
  } else if (resourceExpression !== undefined && typeof resource !== "string") {
    authIsProvablyValid = false;
  }
  if (typeof resource === "string") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(resource);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      authIsProvablyValid = false;
      checks.push(
        createCheck(
          "error",
          `agents.mcp.auth.resource ${JSON.stringify(resource)} is not an absolute URL. It is the ` +
            "token audience and the base for the metadata URL hosts discover, so it must be the " +
            "endpoint's absolute https URL.",
        ),
      );
    } else if (!oauthUrlUsesSafeTransport(parsed)) {
      authIsProvablyValid = false;
      checks.push(
        createCheck(
          "error",
          `agents.mcp.auth.resource ${JSON.stringify(resource)} must use https (http is allowed for loopback development only).`,
        ),
      );
    } else if (parsed.search || parsed.hash) {
      authIsProvablyValid = false;
      checks.push(
        createCheck(
          "error",
          `agents.mcp.auth.resource ${JSON.stringify(resource)} must not carry a query string or fragment.`,
        ),
      );
    } else if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
      authIsProvablyValid = false;
      checks.push(
        createCheck(
          "error",
          `agents.mcp.auth.resource ${JSON.stringify(resource)} must not carry a trailing slash. ` +
            "OAuth resource identifiers are matched exactly; use the MCP endpoint's canonical path.",
        ),
      );
    } else {
      const mcpProperties = scanTopLevelProperties(mcpBody);
      const configuredPath = evaluateLiteral(mcpProperties.get("path") ?? "");
      if (mcpProperties.has("path") && typeof configuredPath !== "string") {
        authIsProvablyValid = false;
      } else if (typeof configuredPath === "string" && !isValidCapabilityHttpPath(configuredPath)) {
        authIsProvablyValid = false;
        checks.push(
          createCheck(
            "error",
            'agents.mcp.path must be an exact same-origin pathname starting with "/".',
          ),
        );
      } else {
        const endpoint =
          ((configuredPath as string | undefined) ?? "/mcp").replace(/\/$/, "") || "/";
        if (endpoint === OAUTH_PROTECTED_RESOURCE_WELL_KNOWN) {
          authIsProvablyValid = false;
          checks.push(
            createCheck(
              "error",
              `agents.mcp.path must not use the reserved OAuth protected-resource metadata path ${JSON.stringify(OAUTH_PROTECTED_RESOURCE_WELL_KNOWN)}.`,
            ),
          );
        } else if (endpoint !== "/" && parsed.pathname !== endpoint) {
          authIsProvablyValid = false;
          if (!parsed.pathname.endsWith(endpoint)) {
            checks.push(
              createCheck(
                "error",
                `agents.mcp.auth.resource path ${JSON.stringify(parsed.pathname)} does not address the configured MCP endpoint ${JSON.stringify(endpoint)}.`,
              ),
            );
          }
        }
      }
    }
  }

  const authorizationServersExpression = properties.get("authorizationServers");
  const authorizationServers = evaluateLiteral(authorizationServersExpression ?? "");
  if (authorizationServersExpression === undefined) {
    authIsProvablyValid = false;
    if (!authIsPartlyOpaque) {
      checks.push(
        createCheck(
          "error",
          "agents.mcp.auth.authorizationServers must list at least one absolute authorization server issuer URL.",
        ),
      );
    }
  } else if (authorizationServersExpression !== undefined && authorizationServers === undefined) {
    authIsProvablyValid = false;
  } else if (!Array.isArray(authorizationServers) || authorizationServers.length === 0) {
    authIsProvablyValid = false;
    checks.push(
      createCheck(
        "error",
        "agents.mcp.auth.authorizationServers must list at least one absolute authorization server issuer URL.",
      ),
    );
  } else {
    for (const issuer of authorizationServers) {
      let parsed: URL | null = null;
      if (typeof issuer === "string") {
        try {
          parsed = new URL(issuer);
        } catch {
          parsed = null;
        }
      }
      if (!parsed) {
        authIsProvablyValid = false;
        checks.push(
          createCheck(
            "error",
            `agents.mcp.auth.authorizationServers contains a non-absolute issuer URL: ${JSON.stringify(issuer)}.`,
          ),
        );
      } else if (!oauthUrlUsesSafeTransport(parsed)) {
        authIsProvablyValid = false;
        checks.push(
          createCheck(
            "error",
            `agents.mcp.auth.authorizationServers issuer ${JSON.stringify(issuer)} must use https (http is allowed for loopback development only).`,
          ),
        );
      } else if (parsed.search || parsed.hash) {
        authIsProvablyValid = false;
        checks.push(
          createCheck(
            "error",
            `agents.mcp.auth.authorizationServers issuer ${JSON.stringify(issuer)} must not carry a query string or fragment.`,
          ),
        );
      }
    }
  }

  const resourceDocumentationExpression = properties.get("resourceDocumentation");
  if (resourceDocumentationExpression !== undefined) {
    const resourceDocumentation = evaluateLiteral(resourceDocumentationExpression);
    if (typeof resourceDocumentation !== "string") {
      authIsProvablyValid = false;
    } else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(resourceDocumentation);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        authIsProvablyValid = false;
        checks.push(
          createCheck(
            "error",
            `agents.mcp.auth.resourceDocumentation ${JSON.stringify(resourceDocumentation)} is not an absolute URL.`,
          ),
        );
      } else if (!oauthUrlUsesSafeTransport(parsed)) {
        authIsProvablyValid = false;
        checks.push(
          createCheck(
            "error",
            `agents.mcp.auth.resourceDocumentation ${JSON.stringify(resourceDocumentation)} must use https (http is allowed for loopback development only).`,
          ),
        );
      }
    }
  }

  for (const field of ["scopesSupported", "requiredScopes"] as const) {
    const expression = properties.get(field);
    if (expression === undefined) continue;
    const scopes = evaluateLiteral(expression);
    if (scopes === undefined) {
      authIsProvablyValid = false;
    } else if (!Array.isArray(scopes) || scopes.some((scope) => !isValidOAuthScopeToken(scope))) {
      authIsProvablyValid = false;
      checks.push(
        createCheck(
          "error",
          `agents.mcp.auth.${field} must be an array of OAuth scope tokens using printable ASCII except quotes and backslashes.`,
        ),
      );
    }
  }

  const verifyExpression = findProvableTopLevelProperty(authBody, "verify");
  if (verifyExpression === undefined) {
    if (!authIsPartlyOpaque) {
      checks.push(
        createCheck(
          "error",
          "agents.mcp.auth is configured without a `verify` module. The endpoint would advertise " +
            "authentication it never performs — add " +
            '`verify: () => import("./server/mcp-token.ts")` whose default export verifies a bearer token.',
        ),
      );
    }
    return;
  }

  const verifyPath = extractMcpVerifyModulePath(verifyExpression);
  if (!verifyPath) {
    checks.push(
      createCheck(
        "error",
        "agents.mcp.auth.verify must be a module reference such as " +
          '`verify: () => import("./server/mcp-token.ts")`.',
      ),
    );
    return;
  }

  const filePath = verifyPath.startsWith("/")
    ? resolveProjectPath(project.root, verifyPath)
    : resolve(dirname(manifestPath), verifyPath);
  if (!existsSync(filePath)) {
    checks.push(
      createCheck(
        "error",
        `agents.mcp.auth.verify references missing file ${JSON.stringify(verifyPath)}.`,
      ),
    );
    return;
  }

  // The runtime resolves the verifier from the registry, and the Vite plugin
  // only globs three directories into it. A module that exists but sits outside
  // all three is never registered, so every /mcp request answers 401 forever —
  // with a config that looks correct and a file that is right there.
  const registryDirs = [project.serverDir, project.middlewareDir, project.capabilitiesDir];
  const inRegistry = registryDirs.some((dir) => isInsideDirectory(project.root, dir, filePath));
  if (!inRegistry) {
    checks.push(
      createCheck(
        "error",
        `agents.mcp.auth.verify module ${JSON.stringify(verifyPath)} is outside the directories ` +
          `the build registers (${registryDirs.join(", ")}), so the runtime can never load it and ` +
          `every /mcp request would answer 401. Move it to ${project.serverDir}/.`,
      ),
    );
    return;
  }

  if (authIsProvablyValid) {
    checks.push(
      createCheck("ok", "Remote MCP endpoint is an OAuth 2.0 protected resource (RFC 9728)."),
    );
  }
}

/** A statically provable ModuleRef shape that the manifest transform supports. */
function extractMcpVerifyModulePath(expression: string): string | null {
  const literal = evaluateLiteral(expression);
  if (typeof literal === "string" && literal !== "") return literal;

  const importRef = /^\s*\(\)\s*=>\s*import\(\s*(["'])([^"']+)\1\s*\)\s*$/.exec(expression);
  return importRef?.[2] ?? null;
}

/**
 * Read an explicit top-level property even when an earlier spread truncated the
 * shared scanner. A later spread resets the proof because it may override the
 * value; a later explicit property makes the value knowable again.
 */
function findProvableTopLevelProperty(objectBody: string, key: string): string | undefined {
  const searchable = maskCommentsAndStrings(objectBody);
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= searchable.length; index += 1) {
    const character = searchable[index];
    if (character === "{" || character === "[" || character === "(") depth += 1;
    else if (character === "}" || character === "]" || character === ")") depth -= 1;
    if ((character === "," && depth === 0) || index === searchable.length) {
      entries.push(objectBody.slice(start, index));
      start = index + 1;
    }
  }

  let expression: string | undefined;
  for (const entry of entries) {
    if (maskCommentsAndStrings(entry).trimStart().startsWith("...")) {
      expression = undefined;
      continue;
    }
    const candidate = scanTopLevelProperties(entry).get(key);
    if (candidate !== undefined) expression = candidate;
  }
  return expression;
}

function oauthUrlUsesSafeTransport(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
}

function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]") {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return !!ipv4 && Number(ipv4[1]) === 127 && ipv4.slice(1).every((part) => Number(part) <= 255);
}

/** Whether an absolute file path sits inside a project-relative directory. */
function isInsideDirectory(root: string, dir: string, filePath: string): boolean {
  const absoluteDir = resolveProjectPath(root, dir);
  const relative = relativePath(absoluteDir, filePath);
  return relative !== "" && !relative.startsWith("..") && !isAbsolutePath(relative);
}

/**
 * Conservative source scan for `agents: { … mcp: … }` in the manifest.
 *
 * Verification is static (no Vite server), so a manifest that builds its
 * `agents` config in a separate variable reads as unconfigured. That only
 * costs one spurious warning, never a failed build — which is why this stays
 * a warning.
 */
function manifestConfiguresMcpProjection(manifestSource: string): boolean {
  const agentsIndex = manifestSource.search(/\bagents\s*:\s*\{/);
  if (agentsIndex === -1) return false;
  return /\bmcp\s*:/.test(manifestSource.slice(agentsIndex));
}

/**
 * The generated browser client turns dotted names into nested objects, so
 * `notes.search` becomes `capabilities.notes.search`. A name that is also a
 * prefix of another (`notes` alongside `notes.search`) cannot be both a
 * function and a namespace: the namespace wins and the shorter name is only
 * reachable through `callCapability()`. Warn rather than error — the capability
 * still works over HTTP and through every other projection.
 */
function collectShadowedNameChecks(names: string[], checks: Check[]): void {
  for (const name of names) {
    const shadowedBy = names.filter((other) => other.startsWith(`${name}.`));
    if (shadowedBy.length > 0) {
      checks.push(
        createCheck(
          "warning",
          `Capability ${JSON.stringify(name)} is also a namespace for ` +
            `${shadowedBy.map((other) => JSON.stringify(other)).join(", ")}, so it is not reachable ` +
            "on the generated capabilities client. Call it via callCapability() or rename it.",
        ),
      );
    }
  }
}

/**
 * The nested client contains only endpoints that the build can prove are
 * HTTP-exposed. Private, WebMCP-only, and invalid or dynamic exposure entries
 * cannot create a runtime namespace collision and must not trigger the warning.
 */
function hasValidStaticHttpExposure(source: string): boolean {
  const args = extractDefineCapabilityArgs(source);
  if (!args) return false;
  const properties = scanTopLevelProperties(args);
  const exposeFlags = readExposeFlags(properties.get("expose"));
  return exposeFlags.hasHttp && !exposeFlags.unknown && exposeFlags.problems.length === 0;
}

function collectSingleCapabilityChecks(
  name: string,
  displayPath: string,
  source: string,
  registeredMiddleware: Set<string>,
  checks: Check[],
  graph: {
    mcpExposed: string[];
    destructiveMcpExposed: string[];
    projection: McpProjectionConfigScan;
  },
): void {
  const { mcpExposed, destructiveMcpExposed, projection } = graph;
  const label = `Capability ${JSON.stringify(name)} (${displayPath})`;
  const args = extractDefineCapabilityArgs(source);
  if (!args) {
    checks.push(
      createCheck(
        "error",
        `${label} does not contain a statically analyzable defineCapability({ ... }) call.`,
      ),
    );
    return;
  }

  const properties = scanTopLevelProperties(args);
  const title = readStaticString(properties.get("title"));
  const description = readStaticString(properties.get("description"));
  const effect = readStaticString(properties.get("effect"));
  const problems: string[] = [];

  const missing: string[] = [];
  if (title.kind === "absent") missing.push("title");
  if (description.kind === "absent") missing.push("description");
  if (!properties.has("input")) missing.push("input schema");
  if (!properties.has("output")) missing.push("output schema");
  if (effect.kind === "absent") missing.push("effect");
  if (missing.length > 0) {
    problems.push(`is missing required fields: ${missing.join(", ")}`);
  }

  const exposeFlags = readExposeFlags(properties.get("expose"));
  const exposed = exposeFlags.hasHttp || exposeFlags.hasMcp || exposeFlags.hasWebmcp;
  const hasMcp = !exposeFlags.unknown && exposeFlags.hasMcp;
  problems.push(...exposeFlags.problems);

  for (const [field, value] of [
    ["title", title],
    ["description", description],
  ] as const) {
    if (value.kind === "invalid") {
      problems.push(`"${field}" must be a non-empty string`);
    } else if (value.kind === "unknown") {
      checks.push(
        createCheck(
          "warning",
          `${label}: the "${field}" field is not an inline string literal, so it could not be verified statically.`,
        ),
      );
    }
  }

  if (effect.kind === "invalid") {
    problems.push('"effect" must be a non-empty string');
  } else if (effect.kind === "unknown") {
    if (!exposeFlags.unknown && exposeFlags.hasHttp) {
      problems.push(
        '"effect" must be an inline "read", "write", or "destructive" string literal for HTTP exposure',
      );
    } else {
      checks.push(
        createCheck(
          "warning",
          `${label}: the "effect" field is not an inline string literal, so it could not be verified statically.`,
        ),
      );
    }
  }

  const effectValue = effect.kind === "valid" ? effect.value : null;
  if (effectValue && !CAPABILITY_EFFECTS.has(effectValue)) {
    problems.push('"effect" must be "read", "write", or "destructive"');
  }

  const agentPolicy = readStaticString(properties.get("agentPolicy"));
  if (properties.has("agentPolicy")) {
    if (agentPolicy.kind === "unknown") {
      checks.push(
        createCheck(
          "warning",
          `${label}: the "agentPolicy" field is not an inline string literal, so it could not be verified statically.`,
        ),
      );
    } else if (agentPolicy.kind !== "valid" || !AGENT_POLICIES.has(agentPolicy.value)) {
      problems.push('"agentPolicy" must be "observe" or "require"');
    }
  }

  const middleware = readMiddlewareNames(properties.get("middleware"));
  if (middleware.kind === "invalid") {
    problems.push('"middleware" must be an array of names');
  } else if (middleware.kind === "unknown") {
    checks.push(
      createCheck(
        "warning",
        `${label}: the "middleware" field is not an inline array literal, so it could not be verified statically.`,
      ),
    );
  } else if (middleware.kind === "valid") {
    for (const middlewareName of middleware.names) {
      if (!registeredMiddleware.has(middlewareName)) {
        problems.push(`references unknown middleware ${JSON.stringify(middlewareName)}`);
      }
    }
  }

  if (exposeFlags.unknown) {
    checks.push(
      createCheck(
        "warning",
        `${label}: the "expose" field is not an inline object literal, so its exposure contract ` +
          "could not be verified statically — including the destructive-exposure and " +
          "confirmation-secret checks. Inline the expose object so verification can cover it.",
      ),
    );
  }

  if (exposed && !exposeFlags.unknown) {
    const { hasHttp, hasWebmcp } = exposeFlags;
    if (hasMcp) {
      mcpExposed.push(name);
      if (!isValidMcpToolName(mcpToolName(name))) {
        problems.push(MCP_TOOL_NAME_ERROR);
      }
    }
    if (hasWebmcp && !hasHttp) {
      problems.push(
        "sets expose.webmcp without expose.http — WebMCP tools dispatch through the HTTP projection",
      );
    }

    if (effectValue === "destructive") {
      if (hasMcp) destructiveMcpExposed.push(name);
      if (hasWebmcp) {
        problems.push(
          "is destructive and exposed as a WebMCP page tool — a browser host's approval UX is " +
            "not a security boundary. Use expose.http, or expose.mcp with agents.mcp.destructive, " +
            "both gated by the prepare/commit confirmation flow",
        );
      } else if (
        (hasHttp || (hasMcp && projection.destructive)) &&
        !process.env.PRACHT_CONFIRMATION_SECRET
      ) {
        problems.push(
          "is destructive and exposed without PRACHT_CONFIRMATION_SECRET in the " +
            "environment — the prepare/commit confirmation flow needs the secret and the " +
            "runtime fails closed without it. Verification reads the real environment, not " +
            "`.env`: `pracht dev` loads that file, but a deployed server takes its " +
            "environment from the platform, so set a real variable (or a Cloudflare secret / " +
            "Vercel environment variable) there",
        );
      }
    }
  }

  const invalidMcpSchemaRoots: string[] = [];
  for (const field of ["input", "output"] as const) {
    const schemaText = properties.get(field);
    if (!schemaText) continue;
    const schema = evaluateLiteral(schemaText);
    if (schema === undefined) {
      checks.push(
        createCheck(
          "warning",
          `${label}: the "${field}" schema is not an inline object literal, so its JSON Schema subset could not be verified statically.`,
        ),
      );
      continue;
    }
    if (
      hasMcp &&
      (!schema ||
        typeof schema !== "object" ||
        Array.isArray(schema) ||
        (schema as { type?: unknown }).type !== "object")
    ) {
      invalidMcpSchemaRoots.push(field);
    }
    const unsupported = collectUnsupportedSchemaKeywords(schema);
    if (unsupported.length > 0) {
      problems.push(
        `"${field}" schema uses unsupported JSON Schema keywords: ${unsupported.join(", ")}`,
      );
    }
    const invalid = collectInvalidSchemaKeywordValues(schema);
    if (invalid.length > 0) {
      problems.push(`"${field}" schema has invalid JSON Schema values: ${invalid.join(", ")}`);
    }
  }
  if (invalidMcpSchemaRoots.length > 0) {
    problems.push(`${MCP_SCHEMA_ROOT_ERROR} (invalid: ${invalidMcpSchemaRoots.join(", ")})`);
  }

  if (problems.length > 0) {
    for (const problem of problems) {
      checks.push(createCheck("error", `${label} ${problem}.`));
    }
    return;
  }

  if (exposeFlags.unknown) {
    // The exposure contract could not be verified; the warning above already
    // says so. Don't claim a complete contract.
    return;
  }

  checks.push(
    createCheck(
      "ok",
      `${label} declares a complete ${exposed ? "exposed" : "private"} contract${effectValue ? ` (effect: ${effectValue})` : ""}.`,
    ),
  );
}

type StaticString =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "unknown" }
  | { kind: "valid"; value: string };

function readStaticString(text: string | undefined): StaticString {
  if (!text) return { kind: "absent" };
  const value = evaluateLiteral(text);
  if (value === undefined) return { kind: "unknown" };
  if (typeof value !== "string" || value.trim() === "") return { kind: "invalid" };
  return { kind: "valid", value };
}

type MiddlewareNames =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "unknown" }
  | { kind: "valid"; names: string[] };

function readMiddlewareNames(text: string | undefined): MiddlewareNames {
  if (!text) return { kind: "absent" };
  const value = evaluateLiteral(text);
  if (value === undefined) return { kind: "unknown" };
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    return { kind: "invalid" };
  }
  return { kind: "valid", names: value };
}

function readExposeFlags(text: string | undefined): {
  hasHttp: boolean;
  hasMcp: boolean;
  hasWebmcp: boolean;
  /** `expose` is present but not an inline literal, so it can't be verified. */
  unknown: boolean;
  problems: string[];
} {
  if (text === undefined) {
    return { hasHttp: false, hasMcp: false, hasWebmcp: false, unknown: false, problems: [] };
  }
  const value = evaluateLiteral(text);
  if (value === undefined) {
    return { hasHttp: false, hasMcp: false, hasWebmcp: false, unknown: true, problems: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      hasHttp: false,
      hasMcp: false,
      hasWebmcp: false,
      unknown: false,
      problems: ['"expose" must be an inline object literal'],
    };
  }
  const expose = value as Record<string, unknown>;
  const problems: string[] = [];
  let hasHttp = false;
  if (expose.http === true) {
    hasHttp = true;
  } else if (expose.http && typeof expose.http === "object" && !Array.isArray(expose.http)) {
    hasHttp = true;
    const http = expose.http as Record<string, unknown>;
    if (http.method !== undefined && http.method !== "POST") {
      problems.push('HTTP exposure only supports method: "POST"');
    }
    if (http.path !== undefined && !isValidCapabilityHttpPath(http.path)) {
      problems.push('HTTP exposure "path" must be an exact same-origin pathname starting with "/"');
    }
  } else if (expose.http !== undefined && expose.http !== false && expose.http !== null) {
    problems.push('"expose.http" must be true or an object');
  }

  return {
    hasHttp,
    hasMcp: expose.mcp === true,
    hasWebmcp: expose.webmcp === true,
    unknown: false,
    problems,
  };
}
