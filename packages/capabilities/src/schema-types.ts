export type JsonSchema = Record<string, unknown>;

export interface CapabilityIssue {
  /** JSON-pointer-ish path into the validated value, e.g. `/limit`. Empty for the root. */
  path: string;
  message: string;
}
