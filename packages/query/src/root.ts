/**
 * A ready-made app root with the default options. Re-export it from
 * `src/root.ts`:
 *
 * ```ts
 * export * from "@pracht/query/root";
 * ```
 *
 * Use `createQueryRoot()` from `@pracht/query` to change the defaults.
 */
import { createQueryRoot } from "./index.ts";

export const { setup, Root, dehydrate, hydrate } = createQueryRoot();
