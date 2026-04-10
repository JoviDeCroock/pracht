import { HTTP_METHODS } from "./constants.js";

export interface ParsedFlags {
  _: string[];
  [key: string]: string | boolean | (string | boolean)[] | string[];
}

export function parseFlags(args: string[]): ParsedFlags {
  const options: ParsedFlags = { _: [] };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }

    if (token.startsWith("--no-")) {
      options[token.slice(5)] = false;
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex !== -1) {
      const key = token.slice(2, equalsIndex);
      const value = token.slice(equalsIndex + 1);
      assignOption(options, key, value);
      continue;
    }

    const key = token.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      assignOption(options, key, next);
      index += 1;
      continue;
    }

    assignOption(options, key, true);
  }

  return options;
}

export function requireStringOption(options: ParsedFlags, key: string): string {
  const value = requireOptionalString(options, key);
  if (!value) {
    throw new Error(`Missing required flag --${key}.`);
  }
  return value;
}

export function requireOptionalString(options: ParsedFlags, key: string): string | null {
  const value = options[key];
  if (Array.isArray(value)) {
    return String(value[value.length - 1]);
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

export function requireEnumOption<T extends string>(
  options: ParsedFlags,
  key: string,
  allowed: T[],
  fallback: T,
): T {
  const value = (requireOptionalString(options, key) ?? fallback) as T;
  if (!allowed.includes(value)) {
    throw new Error(`Invalid value for --${key}. Expected one of ${allowed.join(", ")}.`);
  }
  return value;
}

export function requirePositiveIntegerOption(
  options: ParsedFlags,
  key: string,
  fallback: number,
): number {
  const raw = requireOptionalString(options, key);
  const value = raw == null ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${key} must be a positive integer.`);
  }
  return value;
}

export function parseCommaList(value: unknown): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseApiMethods(value: unknown): string[] {
  const methods = parseCommaList(value);
  const normalized = methods.length === 0 ? ["GET"] : methods.map((entry) => entry.toUpperCase());

  for (const method of normalized) {
    if (!HTTP_METHODS.has(method)) {
      throw new Error(`Unsupported HTTP method "${method}".`);
    }
  }

  return [...new Set(normalized)];
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function assignOption(options: ParsedFlags, key: string, value: string | boolean): void {
  if (!(key in options)) {
    options[key] = value;
    return;
  }

  const existing = options[key];
  if (!Array.isArray(existing)) {
    options[key] = [existing as string | boolean];
  }
  (options[key] as (string | boolean)[]).push(value);
}
