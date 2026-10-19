import { afterEach, describe, expect, it } from "vitest";

import {
  assertHumanApprovalIdentity,
  setCapabilityApprovalPrincipalResolver,
} from "../src/server-internal.ts";

const HUMAN = { confirmation: { mode: "human" as const } };

afterEach(() => {
  setCapabilityApprovalPrincipalResolver(null);
});

describe("assertHumanApprovalIdentity", () => {
  it("throws at startup when human mode has no resolver and no agents.mcp.auth", async () => {
    await expect(
      assertHumanApprovalIdentity(
        { agents: HUMAN, capabilities: { "notes.purge": "./capabilities/purge.ts" } },
        {
          capabilityModules: { "./capabilities/purge.ts": async () => ({ default: {} as never }) },
        },
      ),
    ).rejects.toThrow(/nothing identifies the end user/);
  });

  it("loads capability modules and their middleware before deciding", async () => {
    const loaded: string[] = [];
    await assertHumanApprovalIdentity(
      {
        agents: HUMAN,
        capabilities: { "notes.purge": "./capabilities/purge.ts" },
        middleware: { auth: "./middleware/auth.ts", unrelated: "./middleware/other.ts" },
      },
      {
        capabilityModules: {
          "./capabilities/purge.ts": async () => {
            loaded.push("capability");
            return { default: { middleware: ["auth"] } as never };
          },
        },
        middlewareModules: {
          "./middleware/auth.ts": async () => {
            loaded.push("auth");
            setCapabilityApprovalPrincipalResolver(() => "user-1");
            return { middleware: async (_args, next) => next() };
          },
          "./middleware/other.ts": async () => {
            loaded.push("unrelated");
            return { middleware: async (_args, next) => next() };
          },
        },
      },
    );
    expect(loaded).toEqual(["capability", "auth"]);
  });

  it("skips a capability module that fails to load", async () => {
    await expect(
      assertHumanApprovalIdentity(
        { agents: HUMAN, capabilities: { broken: "./capabilities/broken.ts" } },
        {
          capabilityModules: {
            "./capabilities/broken.ts": async () => {
              throw new Error("boom");
            },
          },
        },
      ),
    ).rejects.toThrow(/nothing identifies the end user/);
  });

  it("accepts agents.mcp.auth, token mode, and an app without capabilities", async () => {
    const capabilities = { "notes.purge": "./capabilities/purge.ts" };
    await assertHumanApprovalIdentity(
      { agents: { ...HUMAN, mcp: { auth: {} } }, capabilities },
      undefined,
    );
    await assertHumanApprovalIdentity({ agents: {}, capabilities }, undefined);
    await assertHumanApprovalIdentity({ agents: HUMAN }, undefined);
  });
});
