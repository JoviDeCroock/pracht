import { describe, expect, it } from "vitest";

import * as server from "../src/server.ts";

describe("@pracht/capabilities/server", () => {
  it("exports the supported host surface without framework request plumbing", () => {
    expect(server).toHaveProperty("createCapabilityHost");
    expect(server).toHaveProperty("createMemoryApprovalStore");
    expect(server).toHaveProperty("verifyAgentSignature");

    expect(server).not.toHaveProperty("setActiveCapabilityHost");
    expect(server).not.toHaveProperty("handleCapabilityRequest");
    expect(server).not.toHaveProperty("resolveAppCapabilities");
    expect(server).not.toHaveProperty("runMiddlewareChain");
  });
});
