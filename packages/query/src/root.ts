/**
 * A ready-made app root with the default options. Re-export it from the
 * module `defineApp({ root })` registers:
 *
 * ```ts
 * export * from "@pracht/query/root";
 * ```
 *
 * Use `createQueryRoot()` from `@pracht/query` to change the defaults.
 */
import { createQueryRoot } from "./index.ts";

export const { setup, Root, dehydrate, hydrate } = createQueryRoot();
