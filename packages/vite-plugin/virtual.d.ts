declare module "virtual:pracht/server" {
  const mod: { fetch: (request: Request, env: any, ctx: any) => Promise<Response> };
  export default mod;
}

declare module "virtual:pracht/client" {}

// `.tsrx` modules are compiled by `@tsrx/vite-plugin-preact`. Declare an
// ambient module so apps can `import` them without a typed source — TypeScript
// has no built-in support for the `.tsrx` extension.
declare module "*.tsrx" {
  const mod: Record<string, unknown>;
  export = mod;
}
