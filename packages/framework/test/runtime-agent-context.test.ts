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
      role: "admin",
    };
    const context = bindAgentContext({}, agent);

    expect(context.agent).not.toBe(agent);
    expect(Object.isFrozen(context.agent)).toBe(true);
    expect(Reflect.set(context.agent!, "keyId", "forged-key")).toBe(false);
    expect(Reflect.set(context, "agent", null)).toBe(false);
    expect(context.agent).toEqual({
      verified: true,
      agentDomain: "verified.example",
      keyId: "verified-key",
    });
    expect(context.agent).not.toHaveProperty("role");
    expect(agent.keyId).toBe("verified-key");
  });

  it("replaces caller-owned frozen identities even when their fields initially match", () => {
    let keyIdReads = 0;
    const suppliedAgent = Object.freeze(
      Object.defineProperties(
        {},
        {
          verified: { enumerable: true, get: () => true },
          agentDomain: { enumerable: true, get: () => "verified.example" },
          keyId: {
            enumerable: true,
            get: () => (keyIdReads++ === 0 ? "verified-key" : "forged-key"),
          },
        },
      ),
    );
    const original = Object.freeze(
      Object.defineProperty({}, "agent", { enumerable: true, value: suppliedAgent }),
    );

    const context = bindAgentContext(original, {
      verified: true,
      agentDomain: "verified.example",
      keyId: "verified-key",
    });

    expect(context).not.toBe(original);
    expect(context.agent).not.toBe(suppliedAgent);
    expect(context.agent?.keyId).toBe("verified-key");
    expect(Object.isFrozen(context.agent)).toBe(true);
  });

  it("preserves constructor identity on immutable class contexts", () => {
    const context = bindAgentContext(Object.freeze(new RequestContext()), null);

    expect(context.constructor).toBe(RequestContext);
    expect(context.constructor.name).toBe("RequestContext");
  });

  it("preserves construction through immutable callable contexts", () => {
    class CallableContext extends RequestContext {
      constructor(_tenant: string, _region: string) {
        super();
      }
    }
    const immutableContext = Object.freeze(CallableContext);
    const BoundContext = bindAgentContext(immutableContext, null);
    class DerivedContext extends BoundContext {}

    const direct = new BoundContext("one", "eu");
    const derived = new DerivedContext("one", "eu");

    expect(BoundContext.name).toBe(CallableContext.name);
    expect(BoundContext.length).toBe(CallableContext.length);
    expect(Object.getOwnPropertyDescriptor(BoundContext, "name")).toEqual(
      Object.getOwnPropertyDescriptor(CallableContext, "name"),
    );
    expect(Object.getOwnPropertyDescriptor(BoundContext, "length")).toEqual(
      Object.getOwnPropertyDescriptor(CallableContext, "length"),
    );
    expect(direct).toBeInstanceOf(CallableContext);
    expect(direct.tenant).toBe("one");
    expect(derived).toBeInstanceOf(CallableContext);
    expect(derived).toBeInstanceOf(DerivedContext);
    expect(derived.tenant).toBe("one");
  });

  it("preserves non-constructable callable context reflection", () => {
    const callable = Object.freeze((tenant: string, region: string) => `${tenant}:${region}`);
    const context = bindAgentContext(callable, null);

    expect(context("one", "eu")).toBe("one:eu");
    expect(context.name).toBe(callable.name);
    expect(context.length).toBe(callable.length);
    expect(Reflect.ownKeys(context)).toEqual([...Reflect.ownKeys(callable), "agent"]);
    expect(Object.hasOwn(context, "prototype")).toBe(false);
    expect(() => Reflect.construct(Object, [], context)).toThrow(TypeError);
  });

  it("preserves array branding on immutable contexts", () => {
    const original = Object.freeze(["one", "two"]);
    const context = bindAgentContext(original, null);

    expect(Array.isArray(context)).toBe(true);
    expect(Object.prototype.toString.call(context)).toBe("[object Array]");
    expect(context.map((tenant) => tenant.toUpperCase())).toEqual(["ONE", "TWO"]);

    expect(() => Object.freeze(context)).not.toThrow();
    expect(Array.isArray(context)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("keeps prototype changes synchronized with the original context", () => {
    const immutablePrototype = { tenant: "one" };
    const immutable = Object.freeze(Object.create(immutablePrototype));
    const immutableContext = bindAgentContext(immutable, null);
    const replacementPrototype = { tenant: "two" };

    expect(Reflect.setPrototypeOf(immutableContext, replacementPrototype)).toBe(false);
    expect(Object.getPrototypeOf(immutableContext)).toBe(immutablePrototype);
    expect(immutableContext.tenant).toBe("one");

    const extensible = Object.defineProperty({} as { agent: null; tenant?: string }, "agent", {
      configurable: false,
      value: null,
      writable: false,
    });
    const extensibleContext = bindAgentContext(extensible, {
      verified: true,
      agentDomain: "verified.example",
      keyId: "verified-key",
    });

    expect(Reflect.setPrototypeOf(extensibleContext, replacementPrototype)).toBe(true);
    expect(Object.getPrototypeOf(extensibleContext)).toBe(replacementPrototype);
    expect(Object.getPrototypeOf(extensible)).toBe(replacementPrototype);
    expect(extensibleContext.tenant).toBe("two");
  });

  it("tracks prototype changes made through a retained source reference", () => {
    const original = Object.defineProperty({} as { agent: null; tenant?: string }, "agent", {
      configurable: false,
      value: null,
      writable: false,
    });
    const context = bindAgentContext(original, {
      verified: true,
      agentDomain: "verified.example",
      keyId: "verified-key",
    });
    const reflectedPrototype = { tenant: "two" };
    const lockedPrototype = { tenant: "three" };

    Object.setPrototypeOf(original, reflectedPrototype);

    expect(context.tenant).toBe("two");
    expect(Object.getPrototypeOf(context)).toBe(reflectedPrototype);

    Object.setPrototypeOf(original, lockedPrototype);

    expect(() => Object.preventExtensions(context)).not.toThrow();
    expect(context.tenant).toBe("three");
    expect(Object.getPrototypeOf(context)).toBe(lockedPrototype);
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

  it("keeps own methods readable after freezing the overlay", () => {
    class OwnMethodContext {
      #tenant = "one";
      readonly readTenant: () => string;

      constructor() {
        this.readTenant = function (this: OwnMethodContext) {
          return this.#tenant;
        };
      }
    }

    const original = Object.freeze(new OwnMethodContext());
    const context = bindAgentContext(original, null);

    expect(context.readTenant()).toBe("one");
    Object.freeze(context);

    expect(context.readTenant()).toBe("one");
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("synchronizes retained source writes before freezing the overlay", () => {
    const original = Object.seal({ tenant: "one" });
    const context = bindAgentContext(original, null);

    Object.preventExtensions(context);
    original.tenant = "two";

    expect(() => Object.freeze(context)).not.toThrow();
    expect(context.tenant).toBe("two");
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("synchronizes reflected descriptors after retained source writes", () => {
    const original = Object.seal({ tenant: "one" });
    const context = bindAgentContext(original, null);

    Object.preventExtensions(context);
    original.tenant = "two";

    expect(context.tenant).toBe("two");
    expect(Object.getOwnPropertyDescriptor(context, "tenant")?.value).toBe("two");
  });

  it("does not let reflective operations shadow immutable source fields", () => {
    const original = Object.freeze({ tenant: "one" });
    const context = bindAgentContext(original, null);

    expect(Reflect.defineProperty(context, "tenant", { value: "forged" })).toBe(false);
    expect(Reflect.deleteProperty(context, "tenant")).toBe(false);
    expect(context.tenant).toBe("one");
    expect(original.tenant).toBe("one");
  });
});
