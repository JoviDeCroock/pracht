// A server island reached only through `import()` is not bound to this route.
export async function Component() {
  const { default: Lazy } = await import("../server-islands/Lazy.ts");
  return Lazy();
}
