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
  name: string;
  test?: RegExp | string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
