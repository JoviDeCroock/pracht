import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

const WEBMCP_FEATURES = "WebMCPTesting,DevToolsWebMCPSupport";

export interface BrowserInfo {
  executable: string;
  name: "Chromium";
  version: string;
}

export interface BrowserToolDescriptor {
  annotations: Record<string, unknown>;
  description: string;
  inputSchema: Record<string, unknown> | null;
  name: string;
  title: string;
}

export interface WebmcpBrowserSession {
  browser: Browser;
  close: () => Promise<void>;
  info: BrowserInfo;
  page: Page;
  timeoutMs: number;
}

export interface WebmcpSupport {
  available: boolean;
  detail: string | null;
  methods: string[];
}

export interface BrowserToolExecution {
  error: string | null;
  value: unknown;
}

/**
 * Find a locally installed Chrome/Chromium build. The verifier never silently
 * downloads a browser: CI should install and pin one, then pass --browser.
 */
export function findWebmcpBrowser(explicit?: string): string {
  if (explicit) {
    if (!isExecutable(explicit)) {
      throw new Error(`The browser executable does not exist or is not executable: ${explicit}`);
    }
    return explicit;
  }

  const candidates = browserCandidates();
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    "No Chrome or Chromium executable was found. Install a compatible Chrome 150+ build " +
      "or pass its pinned executable path with --browser <path>. Pracht does not silently " +
      "download an unpinned browser.",
  );
}

export async function launchWebmcpBrowser(
  options: {
    executable?: string;
    timeoutMs?: number;
  } = {},
): Promise<WebmcpBrowserSession> {
  const executable = findWebmcpBrowser(options.executable);
  const browser = await chromium.launch({
    executablePath: executable,
    headless: true,
    args: [
      `--enable-features=${WEBMCP_FEATURES}`,
      // Some Chromium channels expose the testing flag through the Blink
      // feature name instead of the base feature. Supplying both is harmless.
      "--enable-blink-features=WebMCP",
    ],
    timeout: options.timeoutMs,
  });
  const page = await browser.newPage();
  const timeoutMs = options.timeoutMs ?? 10_000;
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);

  let closed = false;
  return {
    browser,
    page,
    info: { executable, name: "Chromium", version: browser.version() },
    timeoutMs,
    async close() {
      if (closed) return;
      closed = true;
      await browser.close().catch(() => {});
    },
  };
}

export async function readWebmcpSupport(page: Page): Promise<WebmcpSupport> {
  return page.evaluate(() => {
    const context = (document as unknown as { modelContext?: object }).modelContext;
    if (!context) {
      return {
        available: false,
        detail:
          "document.modelContext is unavailable. Use Chrome 150+ with the WebMCP testing feature enabled.",
        methods: [],
      };
    }
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(context)).sort();
    const required = ["executeTool", "getTools", "registerTool"];
    const missing = required.filter(
      (method) => typeof (context as Record<string, unknown>)[method] !== "function",
    );
    return {
      available: missing.length === 0,
      detail:
        missing.length === 0
          ? null
          : `document.modelContext is missing the required method(s): ${missing.join(", ")}.`,
      methods,
    };
  });
}

export async function readBrowserTools(page: Page): Promise<BrowserToolDescriptor[]> {
  return page.evaluate(async () => {
    const context = (
      document as unknown as {
        modelContext: { getTools: () => Promise<Record<string, unknown>[]> };
      }
    ).modelContext;
    const tools = await context.getTools();

    return tools
      .map((tool) => {
        let inputSchema: Record<string, unknown> | null = null;
        if (typeof tool.inputSchema === "string" && tool.inputSchema !== "") {
          try {
            inputSchema = JSON.parse(tool.inputSchema) as Record<string, unknown>;
          } catch {}
        } else if (tool.inputSchema && typeof tool.inputSchema === "object") {
          inputSchema = tool.inputSchema as Record<string, unknown>;
        }
        return {
          annotations:
            tool.annotations && typeof tool.annotations === "object"
              ? (tool.annotations as Record<string, unknown>)
              : {},
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema,
          name: typeof tool.name === "string" ? tool.name : "",
          title: typeof tool.title === "string" ? tool.title : "",
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  });
}

/** Wait for async WebMCP chunk loading, returning the last live registry on timeout. */
export async function waitForBrowserTools(
  page: Page,
  expectedNames: readonly string[],
  timeoutMs = 2_000,
): Promise<BrowserToolDescriptor[]> {
  const expected = [...expectedNames].sort();
  const deadline = Date.now() + timeoutMs;
  let observed: BrowserToolDescriptor[] = [];

  do {
    observed = await withTimeout(
      readBrowserTools(page),
      Math.max(1, deadline - Date.now()),
      "Timed out while reading the browser WebMCP registry.",
    );
    const names = observed.map((tool) => tool.name);
    if (JSON.stringify(names) === JSON.stringify(expected)) return observed;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);

  return observed;
}

export async function navigateWebmcpPage(
  page: Page,
  url: string,
  timeoutMs = 10_000,
): Promise<"client" | "document"> {
  if (page.url() === "about:blank") {
    await page.goto(url, { waitUntil: "networkidle" });
    return "document";
  }

  const canNavigateClient = await page.evaluate(
    () =>
      typeof (window as unknown as { __PRACHT_NAVIGATE__?: unknown }).__PRACHT_NAVIGATE__ ===
      "function",
  );
  if (!canNavigateClient) {
    await page.goto(url, { waitUntil: "networkidle" });
    return "document";
  }

  try {
    await withTimeout(
      page.evaluate(async (target) => {
        await (
          window as unknown as {
            __PRACHT_NAVIGATE__: (href: string) => Promise<void>;
          }
        ).__PRACHT_NAVIGATE__(target);
      }, url),
      timeoutMs,
      `Client navigation to ${url} timed out after ${timeoutMs}ms.`,
    );
    await page.waitForURL(url);
    await page.waitForLoadState("networkidle");
    return "client";
  } catch (error) {
    // Navigating between full and islands hydration intentionally falls back
    // to a document load, which destroys the evaluate context mid-promise.
    if (error instanceof Error && /execution context was destroyed/i.test(error.message)) {
      await page.waitForLoadState("networkidle");
      return "document";
    }
    throw error;
  }
}

/** Invoke through the browser-owned WebMCP dispatch path, optionally cancelling it. */
export async function executeBrowserTool(
  page: Page,
  name: string,
  input: unknown,
  cancelAfterMs?: number,
  timeoutMs = 10_000,
): Promise<BrowserToolExecution> {
  return withTimeout(
    page.evaluate(
      async ({ toolName, toolInput, cancelMs }) => {
        const context = (
          document as unknown as {
            modelContext: {
              executeTool: (tool: unknown, input: unknown, options?: unknown) => Promise<unknown>;
              getTools: () => Promise<Record<string, unknown>[]>;
            };
          }
        ).modelContext;
        const tool = (await context.getTools()).find((candidate) => candidate.name === toolName);
        if (!tool)
          return {
            error: `WebMCP tool ${JSON.stringify(toolName)} is not registered.`,
            value: null,
          };

        const controller = cancelMs === undefined ? null : new AbortController();
        const timer =
          controller === null
            ? null
            : setTimeout(
                () => controller.abort(new DOMException("Scenario cancelled", "AbortError")),
                cancelMs,
              );
        try {
          let raw: unknown;
          try {
            // Chrome 146-152 expects the testing input as a JSON string. The
            // current draft accepts the object itself, so retry that shape only
            // when the browser rejects the string before dispatch.
            raw = await context.executeTool(
              tool,
              JSON.stringify(toolInput),
              controller ? { signal: controller.signal } : undefined,
            );
          } catch (firstError) {
            if (controller?.signal.aborted) throw firstError;
            const detail = firstError instanceof Error ? firstError.message : String(firstError);
            if (!/parse input arguments/i.test(detail)) throw firstError;
            raw = await context.executeTool(
              tool,
              toolInput,
              controller ? { signal: controller.signal } : undefined,
            );
          }
          if (typeof raw !== "string") return { error: null, value: raw };
          try {
            return { error: null, value: JSON.parse(raw) as unknown };
          } catch {
            return { error: null, value: raw };
          }
        } catch (error) {
          const described =
            error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          return { error: described, value: null };
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      },
      { toolName: name, toolInput: input, cancelMs: cancelAfterMs },
    ),
    timeoutMs,
    `WebMCP tool ${JSON.stringify(name)} timed out after ${timeoutMs}ms.`,
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function browserCandidates(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
      "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
      "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter((root): root is string => Boolean(root));
    return roots.flatMap((root) => [
      join(root, "Google", "Chrome SxS", "Application", "chrome.exe"),
      join(root, "Google", "Chrome Dev", "Application", "chrome.exe"),
      join(root, "Google", "Chrome Beta", "Application", "chrome.exe"),
      join(root, "Google", "Chrome", "Application", "chrome.exe"),
      join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }

  const names = [
    "google-chrome-canary",
    "google-chrome-unstable",
    "google-chrome-beta",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .flatMap((directory) => names.map((name) => join(directory, name)));
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
