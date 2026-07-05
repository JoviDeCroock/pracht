import { WorkerEntrypoint } from "cloudflare:workers";

// Extending a `cloudflare:workers` base class exercises the real-world shape
// of worker entrypoints: the import stays external in the server bundle and is
// stubbed by the CLI while prerendering SSG routes in Node.
export class Counter extends WorkerEntrypoint {
  private value = 0;

  override async fetch(): Promise<Response> {
    return Response.json({ value: ++this.value });
  }
}
