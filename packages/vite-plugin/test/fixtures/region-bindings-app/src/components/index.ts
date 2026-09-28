// A barrel: re-exporting a region binds it to every importer of the barrel.
export { default as Barrelled } from "../regions/Barrelled.ts";

export function Button() {
  return "button";
}
