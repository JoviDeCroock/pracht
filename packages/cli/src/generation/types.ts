export interface GenerateResult {
  created: string[];
  kind: string;
  /** Follow-up the caller has to act on, e.g. a missing dependency. */
  notes?: string[];
  updated: string[];
}
