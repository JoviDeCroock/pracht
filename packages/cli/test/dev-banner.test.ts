import { describe, expect, it } from "vitest";

import { formatDevBanner, supportsColor } from "../src/dev-banner.ts";

const routes = [
  { middleware: [], path: "/", render: "ssg", shell: "public" },
  { middleware: [], path: "/pricing", render: "isg", shell: "public" },
  { middleware: [], path: "/products/:id", render: "ssr", shell: "public" },
  { middleware: ["auth"], path: "/dashboard", render: "ssr", shell: "app" },
  { middleware: ["auth", "audit"], path: "/settings", render: "spa", shell: "app" },
];

const apiRoutes = [
  { methods: ["GET"], path: "/api/health" },
  { methods: ["GET", "POST"], path: "/api/echo" },
];

describe("formatDevBanner", () => {
  it("prints the local URL prominently and lists routes with mode, shell, and middleware", () => {
    const banner = formatDevBanner({
      apiRoutes,
      color: false,
      localUrls: ["http://localhost:3000/"],
      networkUrls: ["http://192.168.0.10:3000/"],
      routes,
    });

    expect(banner).toContain("pracht dev");
    expect(banner).toContain("Local:   http://localhost:3000/");
    expect(banner).toContain("Network: http://192.168.0.10:3000/");
    expect(banner).toContain("Routes (5)");
    expect(banner).toContain("API (2)");
    expect(banner).toContain("/products/:id");
    expect(banner).toContain("auth, audit");
    expect(banner).toContain("GET, POST");
  });

  it("aligns route columns", () => {
    const banner = formatDevBanner({
      apiRoutes: [],
      color: false,
      localUrls: ["http://localhost:3000/"],
      routes,
    });

    const lines = banner.split("\n");
    const home = lines.find((line) => line.trimStart().startsWith("/ "));
    const settings = lines.find((line) => line.trimStart().startsWith("/settings"));
    expect(home).toBeDefined();
    expect(settings).toBeDefined();
    // Every mode cell starts at the same column.
    expect(home!.indexOf("ssg")).toBe(settings!.indexOf("spa"));
    // Every shell cell starts at the same column.
    expect(home!.indexOf("public")).toBe(settings!.indexOf("app"));
  });

  it("shows ssr as the effective mode when a route declares none", () => {
    const banner = formatDevBanner({
      apiRoutes: [],
      color: false,
      localUrls: [],
      routes: [{ middleware: [], path: "/implicit", render: null, shell: null }],
    });

    expect(banner).toMatch(/\/implicit\s+ssr/);
  });

  it("emits no ANSI escapes when color is disabled", () => {
    const banner = formatDevBanner({
      apiRoutes,
      color: false,
      localUrls: ["http://localhost:3000/"],
      routes,
    });

    expect(banner).not.toContain("\u001b[");
  });

  it("emits ANSI escapes when color is enabled", () => {
    const banner = formatDevBanner({
      apiRoutes,
      color: true,
      localUrls: ["http://localhost:3000/"],
      routes,
    });

    expect(banner).toContain("\u001b[");
  });

  it("handles empty route and API tables", () => {
    const banner = formatDevBanner({
      apiRoutes: [],
      color: false,
      localUrls: ["http://localhost:3000/"],
      routes: [],
    });

    expect(banner).toContain("Routes (0)");
    expect(banner).toContain("API (0)");
    expect(banner).toContain("(none)");
  });

  it("lists registered capabilities with effect, exposure, and dispatch path", () => {
    const banner = formatDevBanner({
      apiRoutes: [],
      capabilities: [
        {
          effect: "read",
          httpPath: "/api/capabilities/notes/search",
          name: "notes.search",
          transports: ["http", "webmcp"],
        },
        {
          effect: "destructive",
          httpPath: "/api/capabilities/notes/purge",
          name: "notes.purge",
          transports: ["http"],
        },
        { effect: "read", httpPath: null, name: "notes.internal", transports: [] },
      ],
      color: false,
      localUrls: ["http://localhost:3000/"],
      routes: [],
    });

    expect(banner).toContain("Capabilities (3)");
    expect(banner).toMatch(
      /notes\.search\s+read\s+http,webmcp\s+\/api\/capabilities\/notes\/search/,
    );
    expect(banner).toMatch(/notes\.purge\s+destructive\s+http\s+\/api\/capabilities\/notes\/purge/);
    expect(banner).toMatch(/notes\.internal\s+read\s+private\s+-/);
  });

  it("omits the capabilities section when none are registered", () => {
    const banner = formatDevBanner({
      apiRoutes,
      capabilities: [],
      color: false,
      localUrls: ["http://localhost:3000/"],
      routes,
    });

    expect(banner).not.toContain("Capabilities");
  });
});

describe("supportsColor", () => {
  it("respects NO_COLOR over everything else", () => {
    expect(supportsColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(supportsColor({ FORCE_COLOR: "1", NO_COLOR: "1" }, true)).toBe(false);
  });

  it("honors FORCE_COLOR even without a TTY", () => {
    expect(supportsColor({ FORCE_COLOR: "1" }, false)).toBe(true);
  });

  it("falls back to TTY detection", () => {
    expect(supportsColor({}, true)).toBe(true);
    expect(supportsColor({}, false)).toBe(false);
  });
});
