import { describe, expect, it } from "vitest";

import { bindAgentContext } from "../src/runtime-agent-context.ts";

describe("bindAgentContext", () => {
  it("preserves writable fields and receivers on sealed contexts", () => {
    class RequestContext {
      tenant = "one";

      renameTenant(tenant: string) {
        this.tenant = tenant;
        return this.tenant;
      }
    }

    const original = Object.seal(new RequestContext());
    const context = bindAgentContext(original, null);

    context.tenant = "two";
    expect(context.renameTenant("three")).toBe("three");
    expect(context.tenant).toBe("three");
    expect(original.tenant).toBe("three");
    expect(Object.keys(context)).toEqual(["tenant", "agent"]);
    expect(Object.getOwnPropertyDescriptor(context, "tenant")).toMatchObject({
      enumerable: true,
      writable: true,
    });
  });
});
