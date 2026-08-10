import { describe, expect, it } from "vitest";

import { bindAgentContext } from "../src/runtime-agent-context.ts";

describe("bindAgentContext", () => {
  it("preserves writable fields and receivers on sealed contexts", () => {
    class RequestContext {
      tenant = "one";
      #privateTenant = "one";

      get tenantAlias() {
        return this.tenant;
      }

      set tenantAlias(tenant: string) {
        this.tenant = tenant;
      }

      get privateTenant() {
        return this.#privateTenant;
      }

      set privateTenant(tenant: string) {
        this.#privateTenant = tenant;
      }

      renameTenant(tenant: string) {
        this.tenant = tenant;
        return this.tenant;
      }
    }

    const original = Object.seal(new RequestContext());
    const context = bindAgentContext(original, null);

    context.tenant = "two";
    context.tenantAlias = "three";
    context.privateTenant = "private";
    expect(context.renameTenant("four")).toBe("four");
    expect(context.tenant).toBe("four");
    expect(context.privateTenant).toBe("private");
    expect(original.tenant).toBe("four");
    expect(original.privateTenant).toBe("private");
    expect(Object.keys(context)).toEqual(["tenant", "agent"]);
    expect(Object.getOwnPropertyDescriptor(context, "tenant")).toMatchObject({
      enumerable: true,
      writable: true,
    });
  });
});
