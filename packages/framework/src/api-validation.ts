/** Stable public facade for typed API validation. */

export { json } from "./api-json-response.ts";
export {
  apiValidationErrorResponse,
  formDataToRecord,
  isApiValidationErrorBody,
  searchParamsToRecord,
  validateStandardSchema,
} from "./api-request-validation.ts";
export type {
  ApiValidationErrorBody,
  ApiValidationIssue,
  ApiValidationPathSegment,
  ApiValidationSource,
} from "./api-request-validation.ts";
export { defineApi } from "./api-validated-handler.ts";
export type {
  ApiHandlerTypes,
  ApiJsonPrimitive,
  ApiJsonValue,
  ApiRouteMethodMap,
  ApiRouteSchemas,
  DefineApiConfig,
  TypedJsonResponse,
  ValidatedApiArgs,
  ValidatedApiHandler,
} from "./api-validation-types.ts";
