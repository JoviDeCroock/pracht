import type { StandardSchemaV1 } from "@standard-schema/spec";

import { searchParamsToRecord, validateStandardSchema } from "./api-validation.ts";
import { PrachtHttpError, type RouteModule, type RouteSearchRecord } from "./types.ts";

/** Parse raw URL search parameters and apply a route module's optional Standard Schema. */
export async function resolveRouteSearch(
  routeModule: Pick<RouteModule, "search"> | undefined,
  searchParams: URLSearchParams,
): Promise<unknown> {
  const raw = searchParamsToRecord(searchParams) satisfies RouteSearchRecord;
  const schema = routeModule?.search as StandardSchemaV1 | undefined;
  if (!schema) return raw;

  const result = await validateStandardSchema(schema, raw, "query");
  if (!result.issues) return result.value;

  const summary = result.issues
    .map((issue) => {
      const path = issue.path?.length ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
  throw new PrachtHttpError(400, `Invalid search parameters${summary ? `: ${summary}` : ""}`);
}
