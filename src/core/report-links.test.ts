import { describe, expect, it } from "vitest";
import { buildRunReportUrl, normalizeRepositoryUrl, resolveRepositoryUrl } from "./report-links.ts";

const CANON = "https://github.com/o/r";

describe("normalizeRepositoryUrl", () => {
  it.each([
    "https://github.com/o/r",
    "https://github.com/o/r.git",
    "https://github.com/o/r/",
    "git+https://github.com/o/r.git",
    "git@github.com:o/r.git",
    "ssh://git@github.com/o/r.git",
    "github:o/r",
  ])("accepts %s", (raw) => {
    expect(normalizeRepositoryUrl(raw)).toBe(CANON);
  });

  it.each([
    "https://x:tok@github.com/o/r",
    "https://tok@github.com/o/r",
    "http://github.com/o/r",
    "https://gitlab.com/o/r",
    "https://github.com/o/r?x=1",
    "https://github.com/o/r#frag",
    "https://github.com/o",
    "https://github.com/o/r/extra",
    "https://github.com/o/../r",
    "github:o/r r",
    "ssh://user@github.com/o/r.git",
    "",
    "not a url",
  ])("refuses %s", (raw) => {
    expect(() => normalizeRepositoryUrl(raw)).toThrow(expect.objectContaining({ code: "input-invalid" }));
  });
});

describe("resolveRepositoryUrl", () => {
  it("prefers the flag, then package.json, else refuses", () => {
    expect(resolveRepositoryUrl("github:a/b", "github:c/d")).toBe("https://github.com/a/b");
    expect(resolveRepositoryUrl(undefined, "github:c/d")).toBe("https://github.com/c/d");
    expect(() => resolveRepositoryUrl(undefined, undefined)).toThrow(expect.objectContaining({ code: "input-invalid" }));
  });
});

describe("buildRunReportUrl", () => {
  const dir = "eval-cases/case-1/runs/run-1";
  it("builds exact URLs for both targets", () => {
    expect(buildRunReportUrl({ repoUrl: CANON, runRelativeDir: dir, target: "run-folder" })).toBe(`${CANON}/tree/HEAD/${dir}`);
    expect(buildRunReportUrl({ repoUrl: CANON, runRelativeDir: dir, target: "full-report" })).toBe(
      `${CANON}/blob/HEAD/${dir}/EVALS-FULL-REPORT.md`,
    );
  });
  it("refuses traversal and absolute directories", () => {
    for (const bad of ["../x", "a/../b", "/abs", "a//b", ""]) {
      expect(() => buildRunReportUrl({ repoUrl: CANON, runRelativeDir: bad, target: "run-folder" })).toThrow();
    }
  });
});
