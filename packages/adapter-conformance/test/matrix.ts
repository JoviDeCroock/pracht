// Matrix bookkeeping: every row decides, for every target, whether the row
// runs, records a known divergence, or does not apply. A row that leaves a
// target out does not type-check, so a new target has to be placed in every
// row.
import { describe, it } from "vitest";

import { TARGETS, type TargetId } from "./harness.ts";

/** The rewrite step expected to converge the cell (see docs/ADAPTERS.md, "Conformance suite"). */
export type SeamStep = "B" | "C" | "D";

export type Cell =
  | { kind: "run" }
  /** Diverges today: the row runs and must still fail, so a fix has to flip it. */
  | { kind: "fails"; step: SeamStep; why: string }
  /** Diverges today and cannot be exercised until the step lands. */
  | { kind: "todo"; step: SeamStep; why: string }
  /** The platform, not the handler, owns this behaviour; or the target has no such path. */
  | { kind: "na"; why: string };

export const run: Cell = { kind: "run" };
export const fails = (step: SeamStep, why: string): Cell => ({ kind: "fails", step, why });
export const todo = (step: SeamStep, why: string): Cell => ({ kind: "todo", step, why });
export const na = (why: string): Cell => ({ kind: "na", why });

export interface Divergence {
  row: string;
  target: TargetId;
  step: SeamStep;
  why: string;
}

/** Every `fails` and `todo` cell registered so far: the suite's baseline. */
export const divergences: Divergence[] = [];

/**
 * Register one row of the matrix. `test` runs once per target whose cell is
 * `run` or `fails`.
 */
export function row(
  name: string,
  cells: Record<TargetId, Cell>,
  test: (target: TargetId) => Promise<void>,
  options: { timeout?: number } = {},
): void {
  describe(name, () => {
    if (TARGETS.every((target) => cells[target].kind === "na")) {
      it.skip("applies to no target here");
      return;
    }
    for (const target of TARGETS) {
      const cell = cells[target];
      if (cell.kind === "na") continue;
      if (cell.kind === "run") {
        it(target, () => test(target), options.timeout);
        continue;
      }
      divergences.push({ row: name, target, step: cell.step, why: cell.why });
      const title = `${target} (seams step ${cell.step}: ${cell.why})`;
      if (cell.kind === "todo") it.todo(title);
      else it.fails(title, () => test(target), options.timeout);
    }
  });
}
