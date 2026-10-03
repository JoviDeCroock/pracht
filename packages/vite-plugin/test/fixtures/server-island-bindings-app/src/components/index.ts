// A barrel: only importers of `Barrelled` bind it.
export { default as Barrelled } from "../server-islands/Barrelled.ts";
export * from "./more.ts";

export function Button() {
  return "button";
}
