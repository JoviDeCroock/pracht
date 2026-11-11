/**
 * Server scheduling for a page request, pinned with promises the test
 * controls rather than with timing.
 *
 * Middleware is a loader's prerequisite: it authorizes the request and fills
 * the context the loader reads. So the route and shell loaders start together,
 * but only once the middleware chain has let the request through. Code has no
 * such prerequisite, and is imported while middleware is still running.
 */
import { h, type ComponentChildren } from "preact";
import { describe, expect, it } from "vitest";

import {
  defineApp,
  handlePrachtRequest,
  redirect,
  route,
  useRouteData,
  useShellData,
} from "../src/index.ts";
import type { LoaderArgs, MiddlewareFn, ModuleRegistry, ShellModule } from "../src/types.ts";

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every microtask and timer the request has queued so far run out. */
async function settle(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

interface Session {
  userId: string;
}

function createFixture(decide: (session: Session | null) => "allow" | "deny") {
  const events: string[] = [];
  const session = createDeferred<Session | null>();
  const routeData = createDeferred<{ projects: number }>();
  const shellData = createDeferred<{ user: string }>();
  let loaderContext: unknown;

  const app = defineApp({
    middleware: { auth: "./middleware/auth.ts" },
    shells: { app: "./shells/app.tsx" },
    routes: [
      route("/dashboard", "./routes/dashboard.tsx", {
        id: "dashboard",
        middleware: ["auth"],
        render: "ssr",
        shell: "app",
      }),
    ],
  });

  const auth: MiddlewareFn = async ({ context, request }, next) => {
    events.push("middleware:start");
    const current = await session.promise;
    if (decide(current) === "deny") {
      events.push("middleware:deny");
      return redirect("/login", { request });
    }
    (context as { session?: Session | null }).session = current;
    events.push("middleware:allow");
    return next();
  };

  const registry: ModuleRegistry = {
    middlewareModules: {
      "./middleware/auth.ts": async () => ({ middleware: auth }),
    },
    routeModules: {
      "./routes/dashboard.tsx": async () => {
        events.push("route:import");
        return {
          Component: () => {
            const data = useRouteData<{ projects: number }>();
            const shell = useShellData<{ user: string }>();
            return h("main", null, `${shell?.user}:${data.projects}`);
          },
          loader: async ({ context }: LoaderArgs) => {
            events.push("route:loader");
            loaderContext = context;
            return routeData.promise;
          },
        };
      },
    },
    shellModules: {
      "./shells/app.tsx": async () => {
        events.push("shell:import");
        return {
          Shell: (({ children }: { children?: ComponentChildren }) =>
            h("div", null, children)) as ShellModule["Shell"],
          loader: async () => {
            events.push("shell:loader");
            return shellData.promise;
          },
        };
      },
    },
  };

  const request = (headers?: Record<string, string>) =>
    handlePrachtRequest({
      app,
      debugErrors: true,
      registry,
      request: new Request("http://localhost/dashboard", { headers }),
    });

  return { events, loaderContext: () => loaderContext, request, routeData, session, shellData };
}

const requests = [
  { kind: "document", headers: undefined },
  { kind: "client navigation", headers: { "x-pracht-route-state-request": "1" } },
] as const;

describe.each(requests)("server loader scheduling ($kind request)", ({ headers }) => {
  it("holds both loaders until middleware has finished, then starts them together", async () => {
    const fixture = createFixture(() => "allow");
    const responding = fixture.request(headers);
    await settle();

    // Middleware is still deciding. Code does not depend on its answer, so
    // both modules are already imported; the loaders do, so neither has run.
    expect(fixture.events).toContain("middleware:start");
    expect(fixture.events).toContain("route:import");
    expect(fixture.events).toContain("shell:import");
    expect(fixture.events).not.toContain("route:loader");
    expect(fixture.events).not.toContain("shell:loader");

    fixture.session.resolve({ userId: "ada" });
    await settle();

    // Neither loader has resolved, so neither started because the other finished.
    expect(fixture.events).toContain("route:loader");
    expect(fixture.events).toContain("shell:loader");
    expect(fixture.events.indexOf("middleware:allow")).toBeLessThan(
      Math.min(fixture.events.indexOf("route:loader"), fixture.events.indexOf("shell:loader")),
    );
    // The loader read what middleware put on the context.
    expect(fixture.loaderContext()).toMatchObject({ session: { userId: "ada" } });

    fixture.routeData.resolve({ projects: 3 });
    fixture.shellData.resolve({ user: "Ada" });
    const response = await responding;

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(headers ? '"projects":3' : "Ada:3");
  });

  it("starts neither loader when middleware turns the request away", async () => {
    const fixture = createFixture(() => "deny");
    const responding = fixture.request(headers);
    await settle();
    expect(fixture.events).not.toContain("route:loader");
    expect(fixture.events).not.toContain("shell:loader");

    fixture.session.resolve(null);
    const response = await responding;
    await settle();

    expect(fixture.events).toContain("middleware:deny");
    expect(fixture.events).not.toContain("route:loader");
    expect(fixture.events).not.toContain("shell:loader");
    // A document request is redirected; a client navigation is told to follow it.
    const location = headers
      ? ((await response.json()) as { redirect?: string }).redirect
      : response.headers.get("location");
    expect(location).toBe("/login");
  });
});
