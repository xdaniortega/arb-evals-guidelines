/**
 * The isolated validator container.
 *
 * OPT-IN, like the real sandbox tests: it needs `EVAL_CONTAINER_TESTS=1` and a working
 * `container` CLI, and otherwise reports a VISIBLE skip. Run it with `pnpm test:container`.
 *
 * What it proves: the same owner-authored validator that the in-process runner would load
 * on the host produces the same graded outcome inside a fresh, network-less, single-use
 * container, and every identity it created is gone afterwards.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAppleContainerSandbox } from "../sandboxes/apple-container.ts";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContainerValidatorRunner } from "./container-validator.ts";
import { freezeValidatorClosure } from "./case-loader.ts";

const OPT_IN_VARIABLE = "EVAL_CONTAINER_TESTS";
const evalsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const contextDir = join(evalsRoot, "container");

function cliAvailable(): boolean {
  try {
    execFileSync("container", ["--version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const available = process.env[OPT_IN_VARIABLE] === "1" && cliAvailable();

/** A trivial owner-style validator: deterministic, pure, and free of guest input. */
const VALIDATOR_SOURCE = `
import { expected } from "./helper.ts";
export function validateSnapshot(input: { candidateFiles: Record<string, string>; outputPath: string }): {
  status: "graded";
  score: number;
  fullPass: boolean;
  checks: Array<{ id: string; passed: boolean; message: string }>;
} {
  const present = Object.prototype.hasOwnProperty.call(input.candidateFiles, input.outputPath);
  const text = present ? Buffer.from(input.candidateFiles[input.outputPath] ?? "", "base64").toString("utf8") : "";
  const checks = [
    { id: "output-present", passed: present, message: present ? "output present" : "output missing" },
    { id: "output-content", passed: text.trim() === expected, message: "content is " + JSON.stringify(text.trim()) },
  ];
  const passed = checks.filter((check) => check.passed).length;
  return { status: "graded", score: passed / checks.length, fullPass: passed === checks.length, checks };
}
`;

describe("isolated container validator production CLI boundary", () => {
  it("rejects a success frame when the CLI exits nonzero and verifies exact cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "validator-fake-cli-"));
    const cli = join(dir, "container");
    const log = join(dir, "calls.log");
    await writeFile(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$*" in\n  'network create '*) exit 0;;\n  'run '*) printf '%s\\n' '{"ok":true,"outcome":{"status":"graded","score":1,"fullPass":true,"checks":[]}}'; exit 7;;\n  'delete --force '*) exit 0;;\n  'inspect '*) echo 'container not found:' >&2; exit 1;;\n  'network delete '*) exit 0;;\n  'network inspect '*) echo 'network not found:' >&2; exit 1;;\nesac\nexit 9\n`);
    await chmod(cli, 0o755);
    try {
      // This tests nonzero-exit semantics, not startup latency. The 1s setup allowance
      // expired under the full suite's process load before the scripted run was reached.
      // The separate deadline test below retains its deliberately exhausted 20ms budget.
      const runner = createContainerValidatorRunner({ runId: "fake-boundary", cliPath: cli, commandTimeoutMs: 5_000, imageReference: "locked:image" });
      const result = await runner.run({ validatorPath: "unused", validatorSource: "export function validateSnapshot(){}", input: { outputPath: "answer.txt", fixtureFiles: {}, candidateFiles: {}, oracle: {} }, deadlineMs: 5_000, cleanupDeadlineAtMs: Date.now() + 10_000 });
      expect(result.outcome.status).toBe("infrastructure-failure");
      expect(result.failure?.message).toContain("transport failed");
      const calls = await readFile(log, "utf8");
      expect(calls).toContain("delete --force eval-vguest-");
      expect(calls).toContain("inspect eval-vguest-");
      expect(calls).toContain("network delete eval-vnet-");
      expect(calls).toContain("network inspect eval-vnet-");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("does not spawn validator execution after the single grading deadline is consumed by setup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "validator-deadline-cli-"));
    const cli = join(dir, "container");
    const log = join(dir, "calls.log");
    await writeFile(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\ncase "$*" in\n  'network create '*) sleep 0.08; exit 0;;\n  'network delete '*) exit 0;;\n  'network inspect '*) echo 'network not found:' >&2; exit 1;;\n  'delete --force '*) exit 0;;\nesac\nexit 9\n`);
    await chmod(cli, 0o755);
    try {
      const runner = createContainerValidatorRunner({ runId: "deadline-boundary", cliPath: cli, commandTimeoutMs: 1_000, imageReference: "locked:image" });
      const result = await runner.run({ validatorPath: "unused", validatorSource: "export function validateSnapshot(){}", input: { outputPath: "answer.txt", fixtureFiles: {}, candidateFiles: {}, oracle: {} }, deadlineMs: 20, cleanupDeadlineAtMs: Date.now() + 5_000 });
      expect(result.outcome.status).toBe("infrastructure-failure");
      expect(await readFile(log, "utf8")).not.toMatch(/^run /m);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("isolated container validator", () => {
  if (!available) {
    it.skip(
      `requires ${OPT_IN_VARIABLE}=1 and a working \`container\` CLI (run: pnpm test:container)`,
      () => undefined,
    );
    return;
  }

  it(
    "grades a candidate in a fresh network-less container and destroys it",
    async () => {
      const runId = `20260101t000000z-${randomBytes(4).toString("hex")}`;
      const sandbox = createAppleContainerSandbox({ runId, labels: { "eval-test": runId } });
      const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir });
      const workDir = await mkdtemp(join(tmpdir(), "eval-validator-test-"));
      const validatorPath = join(workDir, "validator.ts");
      await writeFile(validatorPath, VALIDATOR_SOURCE);
      await writeFile(join(workDir, "helper.ts"), 'export const expected = "42";');
      const closure = await freezeValidatorClosure(workDir, "validator.ts", "synthetic-validator");
      await rm(validatorPath);
      await rm(join(workDir, "helper.ts"));
      const runner = createContainerValidatorRunner({ runId, labels: { "eval-test": runId } });
      const journaled: string[] = [];
      runner.attachRun({
        imageReference: image.reference,
        record: async (entry) => {
          journaled.push(`${entry.event}:${entry.action}:${entry.kind}:${entry.name}`);
        },
      });
      try {
        expect(runner.testDouble).toBe(false);
        const run = await runner.run({
          validatorPath,
          validatorEntryPath: closure.entryPath,
          validatorBundle: closure.bundle,
          input: {
            outputPath: "answer.txt",
            fixtureFiles: {},
            candidateFiles: { "answer.txt": Buffer.from("42\n").toString("base64") },
            oracle: {},
          },
          deadlineMs: 180_000,
        });
        expect(run.failure).toBe(null);
        expect(run.outcome.status).toBe("graded");
        expect(run.outcome.fullPass).toBe(true);
        expect(run.outcome.score).toBe(1);

        // Every external effect was journaled before invocation, and nothing survives.
        expect(journaled.some((entry) => entry.startsWith("intent:create:guest:"))).toBe(true);
        for (const identity of runner.created) {
          const [kind, name] = identity.split(":") as ["guest" | "network", string];
          expect(await sandbox.inspectResource(kind, name)).toBe("absent");
        }
      } finally {
        // The immutable image is shared cache, not a resource owned by this test run.
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
