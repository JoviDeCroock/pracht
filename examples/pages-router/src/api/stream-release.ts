import type { BaseRouteArgs } from "@pracht/core";

import { releaseStreamLatch } from "../stream-latch.ts";

export function POST({ url }: BaseRouteArgs) {
  releaseStreamLatch(url.searchParams.get("token") ?? "");
  return new Response(null, { status: 204 });
}
