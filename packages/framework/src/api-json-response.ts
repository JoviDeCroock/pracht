import { assertApiJsonValue } from "./api-request-validation.ts";
import type { JsonValueConstraint, TypedJsonResponse } from "./api-validation-types.ts";

/** `Response.json()` with its JSON-safe payload type preserved. */
export function json<TValue>(
  value: TValue & JsonValueConstraint<NoInfer<TValue>>,
  init?: ResponseInit,
): TypedJsonResponse<TValue> {
  assertApiJsonValue(value);
  return Response.json(value, init) as TypedJsonResponse<TValue>;
}
