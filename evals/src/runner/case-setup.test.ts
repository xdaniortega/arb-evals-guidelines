import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAllowlistedEnv } from "../test-guards.ts";
import { discoverAuthoredCases, loadFrozenCase } from "./case-loader.ts";
import { preflightInputs } from "./preflight.ts";
import { preflightForRun } from "./run.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function makeInputs() {
  const repoRoot = await mkdtemp(join(tmpdir(), "eval-case-setup-"));
  roots.push(repoRoot);
  const evalsRoot = join(repoRoot, "evals");
  const caseDir = join(evalsRoot, "cases", "network-config-01");
  await mkdir(caseDir, { recursive: true });
  for (const name of ["case.json", "fixture", "oracle.json", "validator.ts", "validator.test.ts"]) {
    await cp(resolve("evals/cases/network-config-01", name), join(caseDir, name), { recursive: true });
  }
  for (const name of ["first", "second"]) {
    await mkdir(join(repoRoot, "skills", name), { recursive: true });
    await writeFile(join(repoRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n${name}\n`);
  }
  return { repoRoot, evalsRoot, caseDir, caseSelector: "network-config-01" };
}

describe("canonical case and independent treatment setup", () => {
  it("discovers one authored task and freezes identical task bytes for different skills", async () => {
    const input = await makeInputs();
    expect((await discoverAuthoredCases(input.evalsRoot)).map((entry) => entry.selector)).toEqual([input.caseSelector]);
    const first = await loadFrozenCase({ ...input, skillPath: "skills/first" });
    const second = await loadFrozenCase({ ...input, skillPath: "skills/second" });
    expect(first.suiteDir).toBe(input.caseDir);
    expect(second.suiteDir).toBe(input.caseDir);
    expect(first.suite.skillPath).toBe("skills/first");
    expect(second.suite.skillPath).toBe("skills/second");
    expect(first.suite.limits).toEqual({});
    const { suite: _firstSetup, ...firstTask } = first;
    const { suite: _secondSetup, ...secondTask } = second;
    expect(firstTask).toEqual(secondTask);
    await expect(readFile(join(input.caseDir, "eval.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks a case with no skill selected and uses the same defaults and hashes for run setups", async () => {
    const input = await makeInputs();
    await rm(join(input.repoRoot, "skills"), { recursive: true });
    const bare = await preflightInputs({ ...input, suiteId: null, cliLimits: {} });
    expect(bare.ok).toBe(true);
    expect(bare.cases).toHaveLength(1);
    const all = await preflightInputs({ ...input, suiteId: null, caseSelector: null, cliLimits: {} });
    expect(all).toEqual(bare);
    await mkdir(join(input.repoRoot, "skills/first"), { recursive: true });
    await writeFile(join(input.repoRoot, "skills/first/SKILL.md"), "First skill\n");
    const setup = { ...input, suiteId: null, skillPath: "skills/first", cliLimits: {} };
    const checked = await preflightInputs(setup);
    const resolved = await preflightForRun({ ...setup, suiteId: undefined });
    expect(checked.cases).toEqual(bare.cases);
    expect(resolved.resolved.limits).toEqual(bare.cases[0]?.limits);
    // A case with no authored task limits resolves to unlimited (null) by default.
    expect(resolved.resolved.limits.wallClockMs).toBeNull();
    expect(resolved.resolved.limits.maxOutputTokens).toBeNull();
    expect(resolved.resolved.limits.maxToolSteps).toBeNull();
    expect(resolved.resolved.limits.maxProviderRequests).toBeNull();
    const override = await preflightForRun({ ...setup, suiteId: undefined, cliLimits: { wallClockMs: 110000 } });
    expect(override.resolved.limits.wallClockMs).toBe(110000);
    expect(override.resolved.provenance.wallClockMs).toBe("cli");
  });

  it("rejects mismatched case directories and unsafe, missing, or symlinked skill inputs", async () => {
    const input = await makeInputs();
    for (const skillPath of ["../outside", "/tmp/outside", "skills/missing"]) {
      await expect(loadFrozenCase({ ...input, skillPath })).rejects.toThrow();
      expect((await preflightInputs({ ...input, suiteId: null, skillPath, cliLimits: {} })).ok).toBe(false);
    }
    await symlink(join(input.repoRoot, "skills/first"), join(input.repoRoot, "skills/link"));
    await expect(loadFrozenCase({ ...input, skillPath: "skills/link" })).rejects.toMatchObject({ code: "path-unsafe" });
    const config = JSON.parse(await readFile(join(input.caseDir, "case.json"), "utf8"));
    await writeFile(join(input.caseDir, "case.json"), JSON.stringify({ ...config, id: "another-case" }));
    await expect(discoverAuthoredCases(input.evalsRoot)).rejects.toThrow("id must equal its directory name");
  });

  it("gives an actionable migration when a removed legacy suite is requested", async () => {
    const input = await makeInputs();
    await expect(loadFrozenCase({ ...input, suiteId: "old-skill-suite" })).rejects.toThrow("--case <case-id> --skill <path>");
  });

  it.skipIf(process.platform === "win32").each(["case.json", "SKILL.md"])("rejects a FIFO at %s without waiting for a writer", async (name) => {
    const input = await makeInputs();
    const path = name === "case.json" ? join(input.caseDir, name) : join(input.repoRoot, "skills/first", name);
    await rm(path);
    const env = buildAllowlistedEnv(input.repoRoot);
    execFileSync("mkfifo", [path], { env, timeout: 3000 });
    // A separate killable process keeps the regression bounded even if a future
    // blocking open leaves an uncancellable libuv filesystem request outstanding.
    const script = `
      import { loadFrozenCase } from ${JSON.stringify(new URL("./case-loader.ts", import.meta.url).href)};
      try {
        await loadFrozenCase(${JSON.stringify({ ...input, skillPath: "skills/first" })});
        process.exitCode = 1;
      } catch (error) {
        process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
      }
    `;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env, encoding: "utf8", timeout: 3000, killSignal: "SIGKILL",
    });
    expect(JSON.parse(output)).toMatchObject({ code: "path-unsafe", message: expect.stringContaining("must be a regular file") });
  });
});
