/**
 * @internal Framework integration surface.
 *
 * This entry exists so `@pracht/core` can share the capability runtime without
 * making request dispatch, registry plumbing, and protocol helpers part of the
 * supported `@pracht/capabilities/server` API.
 */
export * from "./server/index.ts";
export {
  createRequestBudget,
  holdingWaitUntil,
  holdUntilBodySettles,
  releaseBudgetWith,
  type RequestBudget,
} from "./server/request-budget.ts";
