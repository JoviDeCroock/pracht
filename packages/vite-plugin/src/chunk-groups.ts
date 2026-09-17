/**
 * Pracht's client chunking policy, expressed as something an app can build on.
 *
 * The framework has exactly one opinion here: Preact belongs in its own chunk,
 * shared by every route and cached across deploys that only change app code.
 * Everything else about chunking is the app's call — merging the long tail of
 * small initial chunks, splitting a heavy dependency out of a route, grouping
 * by feature.
 *
 * Those two have to coexist, and under Rolldown that is not automatic:
 * `output.codeSplitting` makes `manualChunks` and `advancedChunks` ignored
 * outright, so a plugin that hard-codes one form silently deletes whichever
 * form the app used. Pracht therefore looks at what the app configured and
 * contributes its group in the same form, as one entry appended to the app's
 * list rather than as a replacement for it.
 *
 * Precedence follows Rolldown's own rule — higher `priority` first, then
 * declaration order. The app's groups are declared first, so an app group that
 * would also capture Preact wins at equal priority, and pracht's group only
 * takes what nothing else claimed. To keep the framework chunk intact while
 * merging everything around it, give the app group a `test` that excludes
 * Preact, or raise pracht's group by placing {@link frameworkChunkGroups}
 * explicitly and setting `vendorChunk: false`.
 */

/**
 * Modules that make up the framework runtime's vendor chunk.
 *
 * `[\\/]` rather than `/` so the group matches on Windows, and no trailing
 * boundary so the Preact family — `preact/hooks`, `preact-suspense`,
 * `preact-render-to-string` — lands in one chunk with Preact itself.
 */
const FRAMEWORK_VENDOR_TEST = /node_modules[\\/]preact/;

/** Name of the chunk pracht groups the Preact runtime into. */
export const FRAMEWORK_VENDOR_CHUNK = "vendor";

export interface ChunkGroup {
  /** A function names each matched module's chunk individually. */
  name: string | ((id: string) => string | null);
  test?: RegExp | string | ((id: string) => boolean);
  priority?: number;
  minSize?: number;
  [option: string]: unknown;
}

/**
 * Pracht's chunk groups, as a fresh array an app can place in its own
 * `output.codeSplitting.groups`.
 *
 * Use this together with `pracht({ vendorChunk: false })` when the framework
 * group has to sit somewhere other than last — pracht then contributes no
 * chunking config of its own and the app's list is the whole policy.
 */
export function frameworkChunkGroups(): ChunkGroup[] {
  return [{ name: FRAMEWORK_VENDOR_CHUNK, test: FRAMEWORK_VENDOR_TEST }];
}

/** Whether a module id belongs in the framework vendor chunk. */
export function isFrameworkVendorModule(id: string): boolean {
  return FRAMEWORK_VENDOR_TEST.test(id);
}

interface OutputOptionsLike {
  codeSplitting?: unknown;
  advancedChunks?: unknown;
  manualChunks?: unknown;
}

type ManualChunksFn = (id: string, meta: unknown) => string | null | undefined | void;

export interface FrameworkChunkConfig {
  /** Partial `build.rollupOptions.output` for Vite to merge over the app's. */
  output?: Record<string, unknown>;
  /** Emitted by the plugin as a warning; `undefined` when there is nothing to say. */
  warning?: string;
}

/**
 * Build the chunking config pracht contributes, given what the app configured.
 *
 * Returns a partial `output` because Vite merges a plugin's `config()` result
 * over the user config and concatenates arrays: returning only pracht's group
 * is what appends it to the app's list instead of replacing it.
 */
export function frameworkChunkConfig(output: unknown): FrameworkChunkConfig {
  if (Array.isArray(output)) {
    // Vite would concatenate our array with theirs (duplicating every output)
    // or, with the object form, replace the whole array. Neither is a chunking
    // policy anyone asked for, so contribute nothing and say so.
    return {
      warning:
        "build.rollupOptions.output is an array, so pracht did not add its Preact vendor " +
        `chunk group. Add frameworkChunkGroups() from @pracht/vite-plugin to each output's ` +
        "codeSplitting.groups to keep the framework chunk.",
    };
  }

  const options = (output ?? {}) as OutputOptionsLike;

  // An explicit `codeSplitting: false` is the app switching code splitting off
  // wholesale; a vendor group cannot mean anything there.
  if (options.codeSplitting === false) return {};

  const groups = frameworkChunkGroups();

  if (options.codeSplitting === undefined) {
    // Rolldown ignores `advancedChunks` as soon as `codeSplitting` is present,
    // so an app still on the deprecated name gets pracht's group in that same
    // shape rather than having its own config silently dropped.
    if (isRecord(options.advancedChunks)) {
      return { output: { advancedChunks: { groups } } };
    }
    // Same reasoning for the (also deprecated) function form: emitting
    // `codeSplitting` here would make the app's `manualChunks` a no-op, so
    // compose with it instead. Pracht answers first — the framework chunk is
    // not something an app opts out of by accident — and delegates otherwise.
    if (typeof options.manualChunks === "function") {
      const appManualChunks = options.manualChunks as ManualChunksFn;
      return {
        output: {
          manualChunks(id: string, meta: unknown) {
            if (isFrameworkVendorModule(id)) return FRAMEWORK_VENDOR_CHUNK;
            return appManualChunks(id, meta);
          },
        },
      };
    }
  }

  return { output: { codeSplitting: { groups } } };
}

/** Name of the chunk an island module is grouped into, per island. */
export const ISLAND_CHUNK_PREFIX = "islands/";

const ISLAND_MODULE_RE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The chunk an island module belongs in, or null for anything else.
 *
 * One chunk per island, mirroring the client build where each island is its
 * own entry: a route that renders one island must not be handed the CSS of
 * every other one.
 */
export function islandChunkName(id: string, islandsDirectory: string): string | null {
  const moduleId = id.replace(/\\/g, "/").split("?")[0] ?? "";
  const directory = islandsDirectory.replace(/\\/g, "/").replace(/\/$/, "");
  if (!moduleId.startsWith(`${directory}/`)) return null;
  const withinIslands = moduleId.slice(directory.length + 1);
  // Stylesheets and other assets follow the module that imported them; naming
  // them separately would split an island from its own CSS.
  if (!ISLAND_MODULE_RE.test(withinIslands)) return null;
  return `${ISLAND_CHUNK_PREFIX}${withinIslands.replace(/\.[^./]+$/, "")}`;
}

/**
 * The chunking pracht contributes to the *server* build.
 *
 * `virtual:pracht/server` imports every island eagerly, so the islands — and
 * whatever they share with a route — are reachable from the server entry and
 * get absorbed into its chunk. The entry's stylesheet is then the whole app's
 * CSS merged into one file, which is no use to a single route: a route that
 * does not fully hydrate resolves its CSS from this build, and the only honest
 * answer the chunk graph could give was "nothing". Splitting islands out
 * restores the boundary the client build has by construction.
 *
 * Contributed in whichever form the app configured, for the same reason
 * {@link frameworkChunkConfig} is.
 */
export function islandChunkConfig(output: unknown, islandsDirectory: string): FrameworkChunkConfig {
  if (Array.isArray(output)) {
    return {
      warning:
        "build.rollupOptions.output is an array, so pracht did not split islands into their " +
        "own server chunks. Routes that do not fully hydrate may link more CSS than they use.",
    };
  }

  const options = (output ?? {}) as OutputOptionsLike;
  if (options.codeSplitting === false) return {};

  const groups: ChunkGroup[] = [
    {
      name: (id: string) => islandChunkName(id, islandsDirectory),
      test: (id: string) => islandChunkName(id, islandsDirectory) !== null,
    },
  ];

  if (options.codeSplitting === undefined) {
    if (isRecord(options.advancedChunks)) {
      return { output: { advancedChunks: { groups } } };
    }
    if (typeof options.manualChunks === "function") {
      const appManualChunks = options.manualChunks as ManualChunksFn;
      return {
        output: {
          manualChunks(id: string, meta: unknown) {
            return islandChunkName(id, islandsDirectory) ?? appManualChunks(id, meta);
          },
        },
      };
    }
  }

  return { output: { codeSplitting: { groups } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
