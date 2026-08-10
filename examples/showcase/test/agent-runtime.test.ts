import { afterEach, describe, expect, it } from "vitest";

import { approvalStore, resetApprovalStore } from "../src/server/agent-runtime.ts";

afterEach(() => resetApprovalStore());

describe("showcase approval reset", () => {
  it("replaces consumed approval state so the same demo operation can start again", async () => {
    const previousStore = approvalStore;
    await previousStore.create({
      id: "archive-corvus",
      principal: "app:user_ada",
      capability: "projects.archive",
      inputHash: "input-hash",
      input: { projectId: "corvus" },
      requiresApproval: true,
      createdAt: 1,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      state: "consumed",
      decidedBy: "ada@launchpad.example",
      decidedAt: 2,
    });

    resetApprovalStore();

    expect(approvalStore).not.toBe(previousStore);
    expect(await approvalStore.get("archive-corvus")).toBeNull();
  });
});
