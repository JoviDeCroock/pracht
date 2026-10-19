import { stripAnsi } from "@pracht/core/error-overlay";

import { HTTP_METHODS, type HttpMethod } from "./constants.js";

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

export function parseCommaList(value: string | string[] | boolean | undefined): string[] {
  if (!value || typeof value === "boolean") return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseApiMethods(value: string | string[] | boolean | undefined): HttpMethod[] {
  const methods = parseCommaList(value);
  const normalized =
    methods.length === 0
      ? (["GET"] as HttpMethod[])
      : methods.map((entry) => entry.toUpperCase() as HttpMethod);

  for (const method of normalized) {
    if (!HTTP_METHODS.has(method)) {
      throw new Error(`Unsupported HTTP method "${method}".`);
    }
  }

  return [...new Set(normalized)];
}

export function requireEnum(
  value: string | undefined,
  key: string,
  allowed: string[],
  fallback: string,
): string {
  const val = value ?? fallback;
  if (!allowed.includes(val)) {
    throw new Error(`Invalid value for --${key}. Expected one of ${allowed.join(", ")}.`);
  }
  return val;
}

export function requirePositiveInteger(
  value: string | undefined,
  key: string,
  fallback: number,
): number {
  // Treat an unset OR empty env var (`PORT=`) as absent so it falls back
  // instead of parsing to NaN and throwing.
  const parsed = value == null || value === "" ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive integer.`);
  }
  return parsed;
}

/** Whether `stream` gets ANSI colour: a terminal, with `NO_COLOR` unset. */
export function colorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(stream.isTTY);
}

/**
 * `text` as `stream` should print it. Errors from Vite and the bundler arrive
 * with their code frames already coloured; a pipe, a log file, or `NO_COLOR`
 * gets them without the escape sequences.
 */
export function terminalText(text: string, stream: { isTTY?: boolean } = process.stderr): string {
  return colorEnabled(stream) ? text : stripAnsi(text);
}

/**
 * Report a failed command and exit 1. With `json`, the whole report is one
 * `{ ok: false, error }` object (never colour, never a stack); otherwise the
 * message alone, and the stack only under `DEBUG`.
 */
export function handleCliError(error: unknown, { json }: { json: boolean }): never {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.error(JSON.stringify({ ok: false, error: stripAnsi(message) }, null, 2));
  } else {
    console.error(terminalText(message));
    if (error instanceof Error && error.stack && process.env.DEBUG) {
      console.error(terminalText(error.stack));
    }
  }
  process.exit(1);
}
