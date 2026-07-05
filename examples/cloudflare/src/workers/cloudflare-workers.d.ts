// Minimal ambient types for the `cloudflare:workers` runtime module so the
// example typechecks without pulling in @cloudflare/workers-types. The real
// module only exists inside workerd; `pracht build` stubs it during SSG
// prerendering.
declare module "cloudflare:workers" {
  export class WorkerEntrypoint {
    fetch?(request: Request): Response | Promise<Response>;
  }
  export class DurableObject {}
}
