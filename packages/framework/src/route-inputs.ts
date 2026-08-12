/** Raw route params as loaders and route modules receive them. */
export type RouteParams = Record<string, string>;

/** Values accepted when interpolating a route path. */
export type RouteParamInput = string | number | boolean;

export type SearchParamPrimitive = string | number | boolean;
export type SearchParamValue =
  | SearchParamPrimitive
  | null
  | undefined
  | readonly (SearchParamPrimitive | null | undefined)[];
export type SearchParamsInput = string | URLSearchParams | Record<string, SearchParamValue>;

export interface BuildHrefOptions {
  params?: Record<string, RouteParamInput>;
  search?: SearchParamsInput;
  hash?: string;
}
