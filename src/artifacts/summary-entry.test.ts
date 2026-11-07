/**
 * Guard tests of `buildSummaryEntry`. Synthetic inputs only; no evidence, no I/O.
 */

import { describe, expect, it } from "vitest";
import type { RunReport } from "./queries.ts";
import type { ScoredReportModel } from "./scored-report.ts";
import { buildSummaryEntry } from "./summary-entry.ts";

describe("buildSummaryEntry", () => {
  it("refuses a verified receipt that carries no manifest tree hash", () => {
    const report = { runId: "run-1", pairs: [], receiptManifest: undefined } as unknown as RunReport;
    const scored = { rubric: undefined, pairIds: [] } as unknown as ScoredReportModel;
    expect(() => buildSummaryEntry({ report, scored, frozenPrompt: null, reportUrl: "https://example.com/r" })).toThrow(
      /run-1 carries no manifest tree hash; refusing to render the summary/,
    );
  });
});
