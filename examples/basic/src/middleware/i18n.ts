import { i18n } from "../i18n/index.ts";

// The manifest expects a module exporting `middleware`. Detection itself is
// configured once in src/i18n/index.ts.
export const middleware = i18n.middleware;
