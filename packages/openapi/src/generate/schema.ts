import type { ApiRouteSchemas } from "@pracht/core";

import type { OpenApiSchema, OpenApiSchemaDirection } from "../types.ts";
import type { GenerateOpenApiOptions, OpenApiRouteSource, OpenApiWarn } from "./model.ts";

export async function bodySchemaRequiresValue(
  schema: NonNullable<ApiRouteSchemas["body"]>,
): Promise<boolean> {
  try {
    const result = await schema["~standard"].validate(undefined);
    return result.issues !== undefined;
  } catch {
    return true;
  }
}

export function resolveSchema(
  source: object,
  direction: OpenApiSchemaDirection,
  allowRawSchema: boolean,
  options: GenerateOpenApiOptions,
  route: OpenApiRouteSource,
  method: string,
  warn: OpenApiWarn,
): OpenApiSchema | undefined {
  try {
    const custom = options.resolveSchema?.(source, direction);
    if (custom) return custom;

    const converter = standardJsonSchemaConverter(source);
    if (converter) return converter[direction]({ target: "draft-2020-12" });

    if (allowRawSchema && isPlainObject(source) && !("~standard" in source)) return source;

    warn(
      route,
      "schema_conversion_unavailable",
      `The ${direction} schema does not implement Standard JSON Schema and no custom resolver converted it.`,
      method,
    );
  } catch (error) {
    warn(
      route,
      "schema_conversion_failed",
      `The ${direction} schema conversion failed: ${error instanceof Error ? error.message : String(error)}`,
      method,
    );
  }
  return undefined;
}

export function objectProperties(
  schema: OpenApiSchema | undefined,
): Record<string, OpenApiSchema> | null {
  if (!schema || !isPlainObject(schema.properties)) return null;
  const properties: Record<string, OpenApiSchema> = {};
  for (const [name, value] of Object.entries(schema.properties)) {
    if (isPlainObject(value)) properties[name] = value;
  }
  return properties;
}

function standardJsonSchemaConverter(source: object):
  | {
      input(options: { target: string }): OpenApiSchema;
      output(options: { target: string }): OpenApiSchema;
    }
  | undefined {
  const standard = (source as { "~standard"?: unknown })["~standard"];
  if (!isPlainObject(standard)) return undefined;
  const converter = standard.jsonSchema;
  if (!isPlainObject(converter)) return undefined;
  if (typeof converter.input !== "function" || typeof converter.output !== "function") {
    return undefined;
  }
  return converter as ReturnType<typeof standardJsonSchemaConverter>;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
