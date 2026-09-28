// A barrel: re-exporting a server island binds it to every importer of the barrel.
export { default as Barrelled } from "../server-islands/Barrelled.ts";

export function Button() {
  return "button";
}
