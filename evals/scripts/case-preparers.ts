/**
 * Explicit production registration table for trusted case preparation.
 *
 * This is the whole "plugin system": a fixed list that binds ONE validated canonical
 * case identity and directory to ONE case-owned `CasePreparer` implementation, loaded
 * through a fixed lazy import. There is deliberately no module discovery, no `preparer`
 * field in the case schema, and no path that a skill, fixture, model, or CLI flag can
 * point at: a case is prepared only if it is literally listed here.
 *
 * What this file does NOT contain, by design:
 * - chain selection, endpoints, fee formulas, or freshness policy (case directory),
 * - when preparation runs, and what a failure means (CLI composition and the runner),
 * - any test seam, fixture, or injected transport (tests use the guarded CLI composition).
 *
 * Matching is by the preflight-resolved suite id, selector, case id, AND absolute case
 * directory under `evals/cases/`. An unqualified id is not sufficient: a legacy `eval.json`
 * suite may contain a case with the same name, and that case must never select
 * the canonical case's preparer.
 */

import { resolve } from "node:path";
import type { CasePreparer } from "../src/core/types.ts";
import type { SelectedRunInputs } from "../src/runner/run.ts";

interface RegisteredCasePreparer {
  /** Canonical cases reuse their own id as the adapter suite id. */
  readonly suiteId: string;
  readonly selector: string;
  readonly caseId: string;
  /** Directory name directly under `evals/cases/`; compared against the resolved case dir. */
  readonly directoryName: string;
  /** Fixed lazy import; never a computed or supplied specifier. */
  readonly load: () => Promise<CasePreparer>;
}

const REGISTERED_CASE_PREPARERS: readonly RegisteredCasePreparer[] = [];

function matches(entry: RegisteredCasePreparer, evalsRoot: string, selection: SelectedRunInputs): boolean {
  const canonicalDir = resolve(evalsRoot, "cases", entry.directoryName);
  return (
    // Canonical selection only: legacy `eval.json` suites have no authored case adapter.
    selection.suite.authoredCase !== undefined &&
    selection.suite.id === entry.suiteId &&
    selection.suite.dir === canonicalDir &&
    selection.selected.suiteId === entry.suiteId &&
    selection.selected.selector === entry.selector &&
    selection.selected.config.id === entry.caseId &&
    selection.selected.dir === canonicalDir
  );
}

/**
 * @notice Looks up the preparer registered for an already validated case selection.
 * @param evalsRoot Absolute `evals/` root the selection was resolved against.
 * @param selection Preflight-resolved suite/case identity, directories, and limits.
 * @returns A callback that lazily imports and invokes the bound implementation, or
 *          `undefined` when the selected case has no registered preparation.
 * @dev The returned callback performs the import on invocation, so unregistered cases,
 * fake runs, retained reproductions, and read-only commands never load case preparation
 * code at all. The runner owns invoking it exactly once before freeze and dispatch.
 */
export function findRegisteredCasePreparer(
  evalsRoot: string,
  selection: SelectedRunInputs,
): CasePreparer | undefined {
  const entry = REGISTERED_CASE_PREPARERS.find((candidate) => matches(candidate, evalsRoot, selection));
  if (entry === undefined) return undefined;
  return async (context) => {
    const preparer = await entry.load();
    return preparer(context);
  };
}

/** Read-only view of the bound identities, for composition tests and diagnostics. */
export const REGISTERED_PREPARED_CASE_SELECTORS: readonly string[] = REGISTERED_CASE_PREPARERS.map(
  (entry) => `${entry.suiteId}/${entry.selector}`,
);
