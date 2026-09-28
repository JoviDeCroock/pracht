// A region reached only through `import()` is not bound to this route.
export async function Component() {
  const { default: Lazy } = await import("../regions/Lazy.ts");
  return Lazy();
}
