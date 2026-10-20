/**
 * Offline preflight over suite and case inputs.
 *
 * This is the policy behind `eval:validate`: discover suites, strictly decode every
 * suite and case, freeze each case's prompt, fixture, oracle, and validator, and
 * resolve its limits through CLI > case > suite > profile > default. It exists in
 * runner/ rather than in scripts/ because it is an algorithm, and because the same
 * checks must run before any paid dispatch in a later phase.
 *
 * It performs no network access, creates no guest, reads no credential, and never
 * touches evals/.env: it only reads the suite data that is already in the repository.
 */

import { EvalError, toStructuredFailure } from "../core/types.ts";
import type { LimitSource, LimitKey, Limits, PartialLimits, RuntimeProfile, RuntimeProfileId, StructuredFailure } from "../core/types.ts";
import { resolveLimits } from "../core/experiment.ts";
import { discoverAuthoredCases, discoverCases, freezeTask, resolveCaseSelector, resolveSetupSuites } from "./case-loader.ts";
import type { CaseRef, SuiteRef } from "./case-loader.ts";

export interface PreflightScope {
  readonly evalsRoot: string;
  readonly repoRoot?: string;
  readonly skillPath?: string | null;
  /** Narrow to one suite id, or every discovered suite when null. */
  readonly suiteId: string | null;
  /** Narrow to one case selector within each in-scope suite, or every case when null. */
  readonly caseSelector: string | null;
  /** Highest-precedence limit overrides, already parsed at the process boundary. */
  readonly cliLimits: PartialLimits;
  /** Optional allowlisted runtime profile catalog. */
  readonly profileCatalog?: Readonly<Record<string, RuntimeProfile>>;
}

export interface CasePreflightResult {
  readonly ok: boolean;
  readonly suiteId: string;
  readonly selector: string;
  readonly caseId: string;
  readonly caseVersion: number;
  readonly runtimeProfileId: RuntimeProfileId | null;
  readonly fixtureFileCount: number;
  readonly promptSha256: string;
  readonly fixtureTreeSha256: string;
  readonly oracleSha256: string;
  readonly validatorSha256: string;
  readonly validatorClosureSha256: string;
  readonly limits: Limits | null;
  readonly limitProvenance: Readonly<Record<LimitKey, LimitSource>> | null;
  readonly failure: StructuredFailure | null;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly suiteIds: readonly string[];
  readonly cases: readonly CasePreflightResult[];
  /** A failure that prevented case enumeration entirely (bad suite config, no match). */
  readonly failure: StructuredFailure | null;
}

function emptyResult(
  suiteId: string,
  selector: string,
  failure: StructuredFailure,
): CasePreflightResult {
  return {
    ok: false,
    suiteId,
    selector,
    caseId: "",
    caseVersion: 0,
    runtimeProfileId: null,
    fixtureFileCount: 0,
    promptSha256: "",
    fixtureTreeSha256: "",
    oracleSha256: "",
    validatorSha256: "",
    validatorClosureSha256: "",
    limits: null,
    limitProvenance: null,
    failure,
  };
}

async function preflightCase(
  suite: SuiteRef | null,
  entry: CaseRef,
  cliLimits: PartialLimits,
  profileCatalog?: Readonly<Record<string, RuntimeProfile>>,
): Promise<CasePreflightResult> {
  try {
    const frozen = await freezeTask(entry, suite?.config.runtimeProfileId);
    const resolved = resolveLimits({
      cli: cliLimits,
      caseLimits: frozen.config.limits,
      suiteLimits: suite?.config.limits ?? {},
      runtimeProfileId: frozen.runtimeProfileId,
      profileCatalog,
    });
    return {
      ok: true,
      suiteId: suite?.id ?? entry.config.id,
      selector: frozen.selector,
      caseId: frozen.config.id,
      caseVersion: frozen.config.version,
      runtimeProfileId: frozen.runtimeProfileId,
      fixtureFileCount: frozen.fixtureFiles.length,
      promptSha256: frozen.promptSha256,
      fixtureTreeSha256: frozen.fixtureTreeSha256,
      oracleSha256: frozen.oracleSha256,
      validatorSha256: frozen.validatorSha256,
      validatorClosureSha256: frozen.validatorClosureSha256,
      limits: resolved.limits,
      limitProvenance: resolved.provenance,
      failure: null,
    };
  } catch (error: unknown) {
    return emptyResult(suite?.id ?? entry.config.id, entry.selector, toStructuredFailure(error, "input-invalid"));
  }
}

/** Discovers, decodes, freezes, and resolves limits for every in-scope case. */
export async function preflightInputs(scope: PreflightScope): Promise<PreflightReport> {
  // A task can be checked before any treatment skill has been selected. No synthetic
  // skill configuration is needed; the same task freezer is used by actual runs.
  if (scope.suiteId === null && scope.skillPath == null) {
    try {
      const discovered = await discoverAuthoredCases(scope.evalsRoot, { profileCatalog: scope.profileCatalog });
      if (discovered.length > 0) {
        const entries = scope.caseSelector === null ? discovered : [resolveCaseSelector(discovered, scope.caseSelector)];
        const cases: CasePreflightResult[] = [];
        for (const entry of entries) cases.push(await preflightCase(null, entry, scope.cliLimits, scope.profileCatalog));
        return { ok: cases.every((result) => result.ok), suiteIds: entries.map((entry) => entry.config.id), cases, failure: null };
      }
    } catch (error) {
      return { ok: false, suiteIds: [], cases: [], failure: toStructuredFailure(error, "input-invalid") };
    }
  }
  let suites: readonly SuiteRef[];
  try {
    suites = await resolveSetupSuites(scope, { profileCatalog: scope.profileCatalog });
  } catch (error: unknown) {
    return { ok: false, suiteIds: [], cases: [], failure: toStructuredFailure(error, "input-invalid") };
  }

  const inScope = suites;

  const results: CasePreflightResult[] = [];
  for (const suite of inScope) {
    let cases: readonly CaseRef[];
    try {
      const discovered = await discoverCases(suite, { profileCatalog: scope.profileCatalog });
      cases = scope.caseSelector === null ? discovered : [resolveCaseSelector(discovered, scope.caseSelector)];
    } catch (error: unknown) {
      results.push(emptyResult(suite.id, scope.caseSelector ?? "(all)", toStructuredFailure(error, "input-invalid")));
      continue;
    }
    if (cases.length === 0) {
      results.push(
        emptyResult(
          suite.id,
          "(all)",
          new EvalError("input-invalid", `suite ${suite.id} contains no case`, { at: suite.id }).toStructured(),
        ),
      );
      continue;
    }
    for (const entry of cases) {
      results.push(await preflightCase(suite, entry, scope.cliLimits, scope.profileCatalog));
    }
  }

  return {
    ok: results.every((result) => result.ok),
    suiteIds: inScope.map((suite) => suite.id),
    cases: results,
    failure: null,
  };
}

/** Compact, content-free human report. Never prints file contents. */
export function formatPreflightReport(report: PreflightReport): string {
  const lines: string[] = [];
  if (report.failure !== null) {
    lines.push(`FAIL [${report.failure.code}] at ${report.failure.at ?? "(unknown)"}: ${report.failure.message}`);
    return lines.join("\n");
  }
  lines.push(`cases: ${report.cases.map((entry) => entry.selector).join(", ")}`);
  for (const result of report.cases) {
    if (!result.ok) {
      const failure = result.failure;
      lines.push(`FAIL ${result.suiteId === result.selector ? result.selector : `${result.suiteId}/${result.selector}`}`);
      lines.push(
        `       [${failure?.code ?? "unknown"}] at ${failure?.at ?? "(unknown)"}: ${failure?.message ?? "unknown failure"}`,
      );
      continue;
    }
    lines.push(
      `PASS ${result.suiteId === result.selector ? result.selector : `${result.suiteId}/${result.selector}`}  profile=${result.runtimeProfileId ?? "?"}  ` +
        `fixtureFiles=${result.fixtureFileCount}  ` +
        `prompt=${result.promptSha256.slice(0, 12)}  tree=${result.fixtureTreeSha256.slice(0, 12)}  ` +
        `oracle=${result.oracleSha256.slice(0, 12)}  validator=${result.validatorSha256.slice(0, 12)}`,
    );
  }
  const failed = report.cases.filter((result) => !result.ok).length;
  lines.push(`${report.cases.length} case(s) checked, ${failed} failed`);
  return lines.join("\n");
}
