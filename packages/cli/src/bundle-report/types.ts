export interface BundleChunk {
  url: string;
  bytes: number;
  gzipBytes: number;
}

export interface RouteBundle {
  id?: string;
  path: string;
  render: string;
  /** Hydration mode; omitted for the default "full". */
  hydration?: string;
  /** Route-specific chunks (route module + shell, excluding shared entry chunks). */
  chunks: BundleChunk[];
  routeBytes: number;
  routeGzipBytes: number;
  /**
   * Full hydration includes shared entry chunks. Islands includes only its
   * bootstrap and island chunks. Hydration "none" ships zero client bytes.
   */
  totalBytes: number;
  totalGzipBytes: number;
}

export interface BundleReport {
  /** Chunks loaded by the client entry on every full-hydration route. */
  shared: {
    chunks: BundleChunk[];
    bytes: number;
    gzipBytes: number;
  };
  /** Sorted by total gzip size, descending. */
  routes: RouteBundle[];
}

export interface BundleReportRoute {
  id?: string;
  path: string;
  render?: string;
  hydration?: string;
  file: string;
  shellFile?: string;
}

export interface CollectBundleReportOptions {
  routes: BundleReportRoute[];
  jsManifest: Record<string, string[]>;
  clientEntryJs: string[];
  /** Transitive chunks of the islands bootstrap entry (empty when unused). */
  islandsEntryJs?: string[];
  /** Source files of all island modules, for islands-route attribution. */
  islandFiles?: string[];
  clientDir: string;
}

export interface BudgetResult {
  path: string;
  render: string;
  /** The budget value as configured ("120kb", 200000, ...). */
  budget: string | number;
  /** Which budget key matched: the route path or "*". */
  source: string;
  limitBytes: number;
  gzipBytes: number;
  ok: boolean;
}

export interface BudgetEvaluation {
  results: BudgetResult[];
  /** Explicit budget keys that did not match any route. */
  unmatched: string[];
  ok: boolean;
}

export interface FormatOptions {
  color?: boolean;
}
