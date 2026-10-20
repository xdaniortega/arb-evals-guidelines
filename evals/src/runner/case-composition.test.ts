import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Guards the trusted preparation boundary against eager case-owned imports. */
describe("case preparation import boundary", () => {
  it("does not statically import case preparation into evaluator composition", async () => {
    for (const path of ["evals/scripts/case-preparers.ts", "evals/scripts/run.ts"]) {
      const source = await readFile(join(process.cwd(), path), "utf8");
      expect(source).not.toMatch(/^\s*import[^\n]*prepare\.ts/m);
      expect(source).not.toMatch(/^\s*export[^\n]*from[^\n]*prepare\.ts/m);
    }
  });
});
