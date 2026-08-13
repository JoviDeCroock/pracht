import { describe, expect, it } from "vitest";

import { isClientDisconnectError } from "../src/node-disconnect.ts";

describe("isClientDisconnectError", () => {
  it("recognizes disconnects through a cause chain", () => {
    const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isClientDisconnectError(new Error("wrapped", { cause: inner }))).toBe(true);
    expect(isClientDisconnectError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe(false);
    expect(isClientDisconnectError(undefined)).toBe(false);
  });

  it("survives a cyclic cause chain", () => {
    // A self- or mutually-referential `cause` is legal. Recursing on it would
    // throw RangeError from inside the handler's own catch block, turning the
    // crash this guard prevents back into an unhandled rejection.
    const first = new Error("first");
    const second = new Error("second");
    (first as { cause?: unknown }).cause = second;
    (second as { cause?: unknown }).cause = first;

    expect(isClientDisconnectError(first)).toBe(false);

    const selfReferential = new Error("self");
    (selfReferential as { cause?: unknown }).cause = selfReferential;
    expect(isClientDisconnectError(selfReferential)).toBe(false);
  });
});
