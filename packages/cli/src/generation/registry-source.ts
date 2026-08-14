import { quote } from "../utils.js";
import { titleCase } from "./paths.js";

export function buildShellModuleSource(name: string): string {
  const title = titleCase(name);
  return [
    'import type { ShellProps } from "@pracht/core";',
    "",
    "export function Shell({ children }: ShellProps) {",
    "  return (",
    `    <div class=${quote(`${name}-shell`)}>`,
    "      <main>{children}</main>",
    "    </div>",
    "  );",
    "}",
    "",
    "export function head() {",
    `  return { title: ${quote(title)} };`,
    "}",
    "",
  ].join("\n");
}

export function buildMiddlewareModuleSource(): string {
  return [
    'import type { MiddlewareFn } from "@pracht/core";',
    "",
    "export const middleware: MiddlewareFn = async (_args, next) => {",
    "  return next();",
    "};",
    "",
  ].join("\n");
}
