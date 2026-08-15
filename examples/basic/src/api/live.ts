import type { BaseRouteArgs } from "@pracht/core";
import { createEventStream } from "@pracht/core/server";

/**
 * Server-Sent Events endpoint: one `tick` event per second, forever. The
 * `send()` return value is the producer's stop condition — it flips to
 * `false` the moment the client disconnects (tab closed, navigation away,
 * curl interrupted), which also clears the keep-alive timer.
 */
export function GET({ request }: BaseRouteArgs) {
  const stream = createEventStream(request, { keepAlive: 15 });

  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const delivered = stream.send({
      data: { now: new Date().toISOString(), tick },
      event: "tick",
      id: String(tick),
    });
    if (!delivered) {
      console.log(`[live] client disconnected after ${tick - 1} ticks; producer stopped`);
      clearInterval(timer);
    }
  }, 1000);

  return stream.response;
}
