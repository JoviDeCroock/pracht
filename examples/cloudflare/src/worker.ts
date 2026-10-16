import { createPrachtHandler, type PrachtHandler } from "@pracht/adapter-cloudflare/worker";

// Named exports are the Worker's Durable Object and WorkerEntrypoint classes.
export { ChatRoom } from "./workers/chat-room.ts";
export { Counter } from "./workers/counter.ts";

const pracht = createPrachtHandler();

// The default export is the Worker itself; pracht serves every request here.
export default {
  fetch(request, env, ctx) {
    return pracht.fetch(request, env, ctx);
  },
} satisfies PrachtHandler;
