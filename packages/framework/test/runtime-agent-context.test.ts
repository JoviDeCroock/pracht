import { describe, expect, it } from "vitest";

import { bindAgentContext } from "../src/runtime-agent-context.ts";

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

describe("bindAgentContext", () => {
  it("preserves writable fields and receivers on sealed contexts", () => {
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

  it("keeps verified identity immutable and detached from the trusted source", () => {
    const agent = {
      verified: true as const,
      agentDomain: "verified.example",
      keyId: "verified-key",
    };
    const context = bindAgentContext({}, agent);

    expect(context.agent).not.toBe(agent);
    expect(Object.isFrozen(context.agent)).toBe(true);
    expect(Reflect.set(context.agent!, "keyId", "forged-key")).toBe(false);
    expect(Reflect.set(context, "agent", null)).toBe(false);
    expect(context.agent).toEqual(agent);
    expect(agent.keyId).toBe("verified-key");
  });

  it("preserves constructor identity on immutable class contexts", () => {
    const context = bindAgentContext(Object.freeze(new RequestContext()), null);

    expect(context.constructor).toBe(RequestContext);
    expect(context.constructor.name).toBe("RequestContext");
  });

  it("supports preventing extensions without violating proxy own-key invariants", () => {
    const original = Object.seal(new RequestContext());
    const context = bindAgentContext(original, null);

    expect(() => Object.preventExtensions(context)).not.toThrow();
    context.tenant = "two";
    expect(context.tenant).toBe("two");
    expect(original.tenant).toBe("two");
    expect(Reflect.ownKeys(context)).toEqual(["tenant", "agent"]);

    expect(() => Object.freeze(context)).not.toThrow();
    expect(Object.isFrozen(context)).toBe(true);
  });
});
