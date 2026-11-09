import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { createDevErrorBuffer, isLocalDiagnosticsRequest } from "../src/dev-diagnostics.ts";

describe("dev diagnostics retention and access", () => {
  it("keeps bounded, newest-first history with a total across eviction", () => {
    const buffer = createDevErrorBuffer();
    for (let i = 0; i < 55; i++) {
      buffer.record({
        path: "/boom",
        phase: "loader",
        routeId: null,
        file: null,
        message: `${i}`,
        stack: "x".repeat(20_000),
      });
    }
    const snapshot = buffer.snapshot();
    expect(snapshot).toMatchObject({ limit: 50, recorded: 55 });
    expect(snapshot.events).toHaveLength(50);
    expect(snapshot.events[0].message).toBe("54");
    expect(snapshot.events[49].message).toBe("5");
    expect(snapshot.events[0].stack).toHaveLength(8192);
  });

  it.each([
    { host: "localhost:3000", address: "127.0.0.1", origin: undefined, allowed: true },
    { host: "[::1]:3000", address: "::1", origin: "http://[::1]:3000", allowed: true },
    {
      host: "localhost:3000",
      address: "::ffff:127.0.0.1",
      origin: "http://localhost:3000",
      allowed: true,
    },
    { host: "localhost:3000", address: "192.168.1.2", origin: undefined, allowed: false },
    { host: "app.example:3000", address: "127.0.0.1", origin: undefined, allowed: false },
    { host: "localhost:3000", address: "127.0.0.1", origin: "http://evil.example", allowed: false },
    { host: "localhost:3000", address: "127.0.0.1", origin: "null", allowed: false },
    {
      host: "localhost:3000",
      address: "127.0.0.1",
      origin: undefined,
      site: "cross-site",
      allowed: false,
    },
  ])(
    "checks loopback host, connection, and origin: $host $address $origin $site",
    ({ host, address, origin, site, allowed }) => {
      const request = {
        headers: { host, origin, "sec-fetch-site": site },
        socket: { remoteAddress: address },
      } as unknown as IncomingMessage;
      expect(isLocalDiagnosticsRequest(request)).toBe(allowed);
    },
  );
});
