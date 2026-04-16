const CLIENT_MODULE_QUERY = "pracht-client";

export const PRACHT_CLIENT_MODULE_QUERY = `?${CLIENT_MODULE_QUERY}`;

export type RolldownLang = "js" | "jsx" | "ts" | "tsx";

export function isPrachtClientModuleId(id: string): boolean {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return false;

  return id
    .slice(queryStart + 1)
    .split("&")
    .includes(CLIENT_MODULE_QUERY);
}

export function stripPrachtClientModuleQuery(id: string): string {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return id;

  const path = id.slice(0, queryStart);
  const query = id
    .slice(queryStart + 1)
    .split("&")
    .filter((part) => part !== CLIENT_MODULE_QUERY);

  return query.length > 0 ? `${path}?${query.join("&")}` : path;
}

export function getRolldownLang(id: string): RolldownLang {
  const path = stripPrachtClientModuleQuery(id).split("?")[0];
  if (/\.(c|m)?tsx$/i.test(path)) return "tsx";
  if (/\.(c|m)?ts$/i.test(path)) return "ts";
  if (/\.(c|m)?jsx$/i.test(path)) return "jsx";
  if (/\.mdx?$/i.test(path)) return "jsx";
  if (/\.(c|m)?js$/i.test(path)) return "js";
  return "tsx";
}
