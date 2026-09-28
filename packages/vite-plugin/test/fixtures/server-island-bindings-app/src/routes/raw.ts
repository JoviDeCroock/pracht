// The source text of a server island is a string, not a rendered server island.
import source from "../server-islands/OrgData.ts?raw";

export function Component() {
  return source;
}
