import { resolve } from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export const cwdInput = {
  cwd: z
    .string()
    .optional()
    .describe("Absolute path to the pracht app root. Defaults to the server's working directory."),
};

export function resolveCwd(cwd: string | undefined): string {
  return resolve(cwd ?? process.cwd());
}

export function guard<Input>(
  handler: (input: Input) => Promise<unknown> | unknown,
): (input: Input) => Promise<CallToolResult> {
  return async (input) => {
    try {
      const result = await handler(input);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}

/** Like guard(), but for handlers that already return display-ready text. */
export function guardText<Input>(
  handler: (input: Input) => Promise<string> | string,
): (input: Input) => Promise<CallToolResult> {
  return async (input) => {
    try {
      return {
        content: [{ type: "text", text: await handler(input) }],
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
