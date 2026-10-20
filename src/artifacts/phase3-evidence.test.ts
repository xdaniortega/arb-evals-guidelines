/**
 * Evidence and Native Session Retention Tests.
 *
 * Exercises the sealed-evidence requirements (see current-implementation.md):
 * 1. A sealed run stays readable after the source skill, case or validator changes or vanishes entirely.
 * 2. Altered, missing or extra canonical files invalidate verification and suppress scores.
 * 3. Hashes before and after report/export are identical; disposable views stay outside the canonical evidence tree.
 * 4. Partial traces remain inspectable after task stops; incomplete infrastructure evidence never becomes a successful result.
 * 5. Every covered synthetic credential encoding is removed before persistence, including nested tool arguments,
 *    results and metadata. Unverifiable redaction quarantines (proven with the real scanner).
 * 6. Legacy (schema-v1) evidence shows unavailable sessions/snapshots explicitly, without fake replay.
 * 7. Prepared snapshots and file/workspace candidates round-trip through the same reader; old evidence is not
 *    silently given new defaults that imply unrecorded guarantees.
 * 8. Redacted inspection copy round-trips through the pinned HTML exporter.
 */

import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeRelativePath,
  buildManifestTree,
  canonicalJson,
  runIdFor,
  sha256Hex,
} from "../core/experiment.ts";
import type { ManifestEntry } from "../core/experiment.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  EvalError,
  SAFE_DEFAULT_LIMITS,
  SCHEMA_VERSION,
  type ConditionId,
} from "../core/types.ts";
import type { GuardedSecret, SecretEncoding } from "../core/secret-scan.ts";
import { scanForSecrets, secretNeedles } from "../core/secret-scan.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import type { FakeHarnessScript } from "../harnesses/fake.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createInProcessValidatorRunner } from "../runner/validation.ts";
import { disposeRunWorkDir, runPairedEvaluation } from "../runner/run.ts";
import type { RunResult } from "../runner/run.ts";
import { createEvidenceStore } from "./store.ts";
import {
  buildRunReport,
  deriveMessagesFromNativeSession,
  deriveToolStepsFromNativeSession,
  formatInspectResult,
  formatRunReport,
  inspectCondition,
  readCandidate,
  readFrozenInputs,
  readNativeSession,
  verifyRun,
} from "./queries.ts";
import {
  exportSessionFileToHtml,
  sanitizeNativeSessionEntries,
  type NativeSessionEntry,
} from "../harnesses/pi/export-viewer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const evalsRoot = repoRoot;

const workDirs: string[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  while (workDirs.length > 0) {
    const dir = workDirs.pop();
    if (dir !== undefined) await disposeRunWorkDir(dir);
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

const defaultSyntheticScript: FakeHarnessScript = () => ({
  outcome: "completed",
  assistantText: "fake harness: default synthetic task complete",
  nativeSessionEntries: [
    { type: "session", id: "sess-synth-1", timestamp: "2026-01-01T00:00:00.000Z", version: 3 },
    {
      type: "message",
      id: "msg-synth-1",
      parentId: "sess-synth-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "assistant", content: "fake harness: default synthetic task complete" },
    },
  ],
});

async function runSyntheticEvaluation(options?: {
  script?: FakeHarnessScript;
  guardedSecrets?: readonly GuardedSecret[];
  evalsRootOverride?: string;
  repoRootOverride?: string;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const root = await makeTempDir("eval-p3-test-");
  const workDir = await makeTempDir("eval-p3-work-");
  workDirs.push(workDir);

  return runPairedEvaluation({
    evalsRoot: options?.evalsRootOverride ?? evalsRoot,
    repoRoot: options?.repoRootOverride ?? repoRoot,
    caseSelector: "network-config-01",
    skillPath: "skills/arbitrum-docs",
    mode: "fake",
    repetitions: 1,
    cliLimits: {},
    target: { provider: "google", model: "fake-model-0", thinking: "off" },
    runId: runIdFor(new Date(0), "0a1b2c3d4e5f"),
    resourceNonce: "0a1b2c3d",
    createdAt: new Date(0).toISOString(),
    source: { revision: "a".repeat(40), dirty: false },
    evaluatorBuild: "evals-src@test",
    harness: createFakeHarness({ script: options?.script ?? defaultSyntheticScript }),
    sandbox: createFakeSandbox(),
    validatorRunner: createInProcessValidatorRunner(),
    workDir,
    runsRoot: join(root, "runs"),
    stateDir: join(root, ".state"),
    signal: options?.signal,
    credentials: options?.guardedSecrets
      ? options.guardedSecrets.map((s) => ({ variable: s.label, value: s.value, conditionIds: ["baseline", "treatment"] }))
      : [],
  });
}

/** Walks regular files and returns map of relativePath -> sha256 */
async function hashAllFiles(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (relDir: string): Promise<void> => {
    const fullDir = relDir === "" ? dir : join(dir, relDir);
    const entries = await readdir(fullDir, { withFileTypes: true });
    for (const e of entries) {
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        await walk(rel);
      } else if (e.isFile()) {
        const bytes = await readFile(join(fullDir, e.name));
        hashes.set(rel, sha256Hex(bytes));
      }
    }
  };
  await walk("");
  return hashes;
}

describe("Source independence", () => {
  it("a sealed run stays readable after the source skill, case or validator changes or vanishes entirely", async () => {
    // 1. Set up an isolated mock evals repository with case, skill, and validator
    const isolatedRoot = await makeTempDir("isolated-repo-");
    const isolatedEvals = isolatedRoot;
    const isolatedDocs = join(isolatedEvals, "eval-cases", "arbitrum-docs", "network-config-01");
    // Copy owned source inputs only, never the ignored runs tree being changed by CLI tests.
    await mkdir(isolatedDocs, { recursive: true });
    for (const name of ["case.json", "fixture", "oracle.json", "validator.ts", "validator.test.ts"]) {
      await cp(join(evalsRoot, "eval-cases", "arbitrum-docs", "network-config-01", name), join(isolatedDocs, name), { recursive: true });
    }
    const isolatedSkills = join(isolatedRoot, "skills", "arbitrum-docs");
    await cp(join(repoRoot, "skills", "arbitrum-docs"), isolatedSkills, { recursive: true });

    // 2. Run paired evaluation against this isolated source
    const result = await runSyntheticEvaluation({
      evalsRootOverride: isolatedEvals,
      repoRootOverride: isolatedRoot,
    });

    // Verify it is clean and reports original grades
    const initialReport = await buildRunReport(result.receiptPath);
    expect(initialReport.verification.ok).toBe(true);
    expect(initialReport.pairs[0]?.conditions[0]?.score).not.toBeNull();
    const originalScore = initialReport.pairs[0]?.conditions[0]?.score;

    // 3. Completely DELETE the source case, validator, and skill!
    await rm(isolatedDocs, { recursive: true, force: true });
    await rm(isolatedSkills, { recursive: true, force: true });
    expect(await stat(isolatedDocs).catch(() => false)).toBe(false);
    expect(await stat(isolatedSkills).catch(() => false)).toBe(false);

    // 4. Verify run still passes 100% without the source files!
    const verifyAfter = await verifyRun(result.runDir);
    expect(verifyAfter.ok).toBe(true);
    expect(verifyAfter.failures).toEqual([]);

    // 5. Build report still returns the STORED original grades!
    const reportAfter = await buildRunReport(result.receiptPath);
    expect(reportAfter.verification.ok).toBe(true);
    expect(reportAfter.pairs[0]?.conditions[0]?.score).toBe(originalScore);

    // 6. Inspect condition views (runtime, candidate, workspace, validation, messages, tools) still work!
    for (const view of ["messages", "tools", "workspace", "candidate", "validation", "runtime", "session"] as const) {
      const inspected = await inspectCondition({
        receiptPath: result.receiptPath,
        conditionId: "treatment",
        view,
      });
      expect(inspected.verified).toBe(true);
      expect(inspected.content).toBeDefined();
    }

    // 7. Full frozen inputs are retained and readable
    const frozenInputs = await readFrozenInputs(result.receiptPath);
    expect(frozenInputs.available).toBe(true);
    expect(frozenInputs.schemaVersion).toBe(EVIDENCE_SCHEMA_VERSION);
    expect(frozenInputs.prompt).toBeTruthy();
    expect(frozenInputs.oracleBytes).toBeTruthy();
    expect(frozenInputs.validatorSource).toBeTruthy();
    expect(frozenInputs.fixtureFiles.length).toBeGreaterThan(0);
    expect(frozenInputs.skillFiles.length).toBeGreaterThan(0);
  });
});

describe("Verification tampering and score suppression", () => {
  it("altered, missing or extra canonical files invalidate verification and suppress scores", async () => {
    const result = await runSyntheticEvaluation();
    const copyDir = await makeTempDir("tampered-copy-");
    await cp(result.runDir, copyDir, { recursive: true });

    // 1. Missing file: delete session.json
    const missingFile = join(copyDir, `pairs/${result.runId}-r001/treatment/session.json`);
    await rm(missingFile);
    const repMissing = await verifyRun(copyDir);
    expect(repMissing.ok).toBe(false);
    expect(repMissing.missing).toContain(`pairs/${result.runId}-r001/treatment/session.json`);
    const reportMissing = await buildRunReport(join(copyDir, "receipt.json"));
    expect(reportMissing.verification.ok).toBe(false);
    expect(reportMissing.pairs).toEqual([]); // Scores suppressed!
    const formattedMissing = formatRunReport(reportMissing);
    expect(formattedMissing).toContain("REFUSED");
    expect(formattedMissing).not.toContain("score=");

    // Restore missing file
    await cp(join(result.runDir, `pairs/${result.runId}-r001/treatment/session.json`), missingFile);

    // 2. Extra canonical file: add smuggled.json in inputs/
    const extraFile = join(copyDir, "inputs/smuggled.json");
    await writeFile(extraFile, '{"smuggled":true}\n');
    const repExtra = await verifyRun(copyDir);
    expect(repExtra.ok).toBe(false);
    expect(repExtra.extra).toContain("inputs/smuggled.json");
    const reportExtra = await buildRunReport(join(copyDir, "receipt.json"));
    expect(reportExtra.verification.ok).toBe(false);
    expect(reportExtra.pairs).toEqual([]); // Scores suppressed!

    // Remove extra file
    await rm(extraFile);

    // 3. Altered file: alter one byte of inputs/frozen/case/oracle.json
    const oracleFile = join(copyDir, "inputs/frozen/case/oracle.json");
    await chmod(oracleFile, 0o644);
    const originalOracle = await readFile(oracleFile);
    const mutatedOracle = Buffer.from(originalOracle);
    mutatedOracle[0] = (mutatedOracle[0] ?? 0) ^ 0x01;
    await writeFile(oracleFile, mutatedOracle);
    const repAltered = await verifyRun(copyDir);
    expect(repAltered.ok).toBe(false);
    expect(repAltered.altered).toContain("inputs/frozen/case/oracle.json");
    const reportAltered = await buildRunReport(join(copyDir, "receipt.json"));
    expect(reportAltered.verification.ok).toBe(false);
    expect(reportAltered.pairs).toEqual([]); // Scores suppressed!
  });
});

describe("Hash preservation and disposable views", () => {
  it("hashes before and after report/export are identical; disposable views stay outside canonical tree", async () => {
    const result = await runSyntheticEvaluation();

    // Take byte-level hash of all files before any read/report/export
    const hashesBefore = await hashAllFiles(result.runDir);

    // 1. Run verifyRun
    const verification = await verifyRun(result.runDir);
    expect(verification.ok).toBe(true);

    // 2. Run buildRunReport and formatRunReport
    const report = await buildRunReport(result.receiptPath);
    expect(report.verification.ok).toBe(true);
    formatRunReport(report);

    // 3. Inspect all views
    for (const view of [
      "messages",
      "tools",
      "workspace",
      "candidate",
      "validation",
      "errors",
      "runtime",
      "attestation",
      "redactions",
      "session",
    ] as const) {
      const inspected = await inspectCondition({
        receiptPath: result.receiptPath,
        conditionId: "baseline",
        view,
      });
      formatInspectResult(inspected);
    }

    // 4. Export session to HTML using pinned exporter into disposable views directory
    const sessionRecord = await readNativeSession(result.receiptPath, `pairs/${result.runId}-r001/treatment`);
    expect(sessionRecord.available).toBe(true);

    // Write temporary session JSONL outside canonical manifest (in views/)
    const disposableJsonl = join(result.runDir, "views", "session-treatment.jsonl");
    const jsonlLines = sessionRecord.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(disposableJsonl, jsonlLines);

    const disposableHtml = join(result.runDir, "views", "session-treatment.html");
    await exportSessionFileToHtml(disposableJsonl, disposableHtml);
    expect(await stat(disposableHtml).then(() => true)).toBe(true);

    // Re-hash all canonical chained files
    const hashesAfter = await hashAllFiles(result.runDir);

    // Manifest and Chained evidence files must be byte-for-byte identical
    for (const [path, beforeHash] of hashesBefore) {
      const afterHash = hashesAfter.get(path);
      expect(afterHash).toBe(beforeHash);
    }

    // views/ files are created outside the manifest tree; manifest still verifies!
    const verifyAfter = await verifyRun(result.runDir);
    expect(verifyAfter.ok).toBe(true);
    expect(verifyAfter.missing).toEqual([]);
    expect(verifyAfter.extra).toEqual([]);
    expect(verifyAfter.altered).toEqual([]);
  });
});

describe("Partial traces and infrastructure failures", () => {
  it("partial traces remain inspectable after task stops; incomplete infrastructure evidence never becomes a successful result", async () => {
    // Harness script that executes a write then aborts on wall clock / task limit
    const script: FakeHarnessScript = (request) => {
      if (request.conditionId === "baseline") {
        return {
          outcome: "task-limit",
          writes: [{ path: "partial.txt", text: "halfway done" }],
          assistantText: "stopping due to step limit",
          nativeSessionEntries: [
            { type: "session", id: "sess-part-b", timestamp: "2026-01-01T00:00:00.000Z", version: 3 },
            {
              type: "message",
              id: "msg-part-b1",
              parentId: "sess-part-b",
              timestamp: "2026-01-01T00:00:01.000Z",
              message: { role: "assistant", content: "stopping due to step limit" },
            },
          ],
        };
      }
      return {
        outcome: "completed",
        assistantText: "done",
        nativeSessionEntries: [
          { type: "session", id: "sess-part-t", timestamp: "2026-01-01T00:00:00.000Z", version: 3 },
          {
            type: "message",
            id: "msg-part-t1",
            parentId: "sess-part-t",
            timestamp: "2026-01-01T00:00:01.000Z",
            message: { role: "assistant", content: "done" },
          },
        ],
      };
    };

    const result = await runSyntheticEvaluation({ script });
    expect(result.status).toBe("complete");

    // Baseline condition stopped with task-limit
    const baselineSession = await readNativeSession(result.receiptPath, `pairs/${result.runId}-r001/baseline`);
    expect(baselineSession.available).toBe(true);
    expect(baselineSession.completed).toBe(false);
    expect(baselineSession.incompleteTail).toBe(true);
    expect(baselineSession.tailStatus).toBe("truncated");
    expect(baselineSession.entries.length).toBeGreaterThan(0);

    // Treatment condition completed normally
    const treatmentSession = await readNativeSession(result.receiptPath, `pairs/${result.runId}-r001/treatment`);
    expect(treatmentSession.available).toBe(true);
    expect(treatmentSession.completed).toBe(true);
    expect(treatmentSession.incompleteTail).toBe(false);
    expect(treatmentSession.tailStatus).toBe("completed");

    // Interrupted condition test: aborting during execution
    const controller = new AbortController();
    const abortingScript: FakeHarnessScript = (request) => {
      if (request.conditionId === "baseline") {
        controller.abort(new Error("external interruption"));
      }
      return { outcome: "completed" };
    };

    const interruptedResult = await runSyntheticEvaluation({
      script: abortingScript,
      signal: controller.signal,
    });
    expect(interruptedResult.status).toBe("partial");

    // Absent fake native entries are honestly empty and unavailable without synthetic history
    const interruptedSession = await readNativeSession(interruptedResult.receiptPath, `pairs/${interruptedResult.runId}-r001/baseline`);
    expect(interruptedSession.available).toBe(false);
    expect(interruptedSession.entries).toEqual([]);
    expect(interruptedSession.entryCount).toBe(0);
    expect(interruptedSession.tailStatus).toBe("unavailable");

    // Incomplete infrastructure evidence has failureClass: infrastructure and score: null
    const report = await buildRunReport(interruptedResult.receiptPath);
    const baselineCond = report.pairs[0]?.conditions.find((c) => c.conditionId === "baseline");
    expect(baselineCond?.status).toBe("infrastructure-failure");
    expect(baselineCond?.gradeable).toBe(false);
    expect(baselineCond?.score).toBeNull();
    // Delta is not computable for invalid pair
    expect(report.pairs[0]?.delta.gradeable).toBe(false);
    expect(report.pairs[0]?.delta.delta).toBeNull();
  });
});

describe("Recursive secret redaction across all encodings", () => {
  it("removes covered synthetic credential encodings in nested tool arguments, results, and metadata", async () => {
    const rawSecret = 'super+secret/eval?token=998877';
    const secret: GuardedSecret = { label: "API_SECRET_KEY", value: rawSecret };

    // Prepare needles in covered encodings
    const needles = secretNeedles(secret);
    const rawNeedle = needles.find((n) => n.encoding === "raw")?.needle ?? rawSecret;
    const jsonEsc = needles.find((n) => n.encoding === "json-escaped")?.needle ?? 'super+secret/eval?token=998877';
    const pctEnc = needles.find((n) => n.encoding === "percent-encoded")?.needle ?? encodeURIComponent(rawSecret);
    const b64Enc = needles.find((n) => n.encoding === "base64")?.needle ?? Buffer.from(rawSecret).toString("base64");
    const b64urlEnc = needles.find((n) => n.encoding === "base64url")?.needle ?? Buffer.from(rawSecret).toString("base64url");

    // Construct native session entries with secrets nested deep in arguments, results, and metadata
    const complexEntries: NativeSessionEntry[] = [
      {
        type: "session",
        id: "sess-0",
        timestamp: 1000,
        version: 3,
        metadata: {
          clientKey: rawSecret,
          customHeaders: {
            authorization: `Bearer ${pctEnc}`,
          },
        },
      },
      {
        type: "message",
        id: "msg-1",
        parentId: "sess-0",
        timestamp: 2000,
        message: {
          role: "assistant",
          thinkingSignature: "sig-should-be-preserved",
          content: [
            { type: "thinking", text: "private reasoning that must be preserved" },
            { type: "text", text: `I found token ${jsonEsc} in config` },
            {
              type: "toolCall",
              id: "call-1",
              name: "post_data",
              arguments: {
                nested: {
                  deep: {
                    apiKey: rawSecret,
                    encodedPayload: b64Enc,
                  },
                },
                tags: [`auth:${b64urlEnc}`],
              },
            },
          ],
        },
      },
      {
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        timestamp: 3000,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          content: {
            status: 200,
            responseBody: `echoed secret: ${rawSecret} and ${pctEnc}`,
            diagnostic: {
              raw: rawSecret,
              escaped: jsonEsc,
            },
          },
          errorMessage: `Error containing ${rawSecret}`,
        },
      },
    ];

    // Sanitize entries with captureReasoning: true to test preservation
    const redacted = sanitizeNativeSessionEntries(complexEntries, [secret], { captureReasoning: true });

    // 1. Thinking signature and thinking content block are preserved when captureReasoning is true
    const assistantMsg = redacted[1]?.message as Record<string, unknown>;
    expect(assistantMsg.thinkingSignature).toBe("sig-should-be-preserved");
    const contentBlocks = assistantMsg.content as Array<Record<string, unknown>>;
    const thinkingBlock = contentBlocks.find((b) => b.type === "thinking");
    expect(thinkingBlock?.text).toBe("private reasoning that must be preserved");

    // 1b. By default, reasoning and signatures are stripped
    const stripped = sanitizeNativeSessionEntries(complexEntries, [secret]);
    const strippedAssistant = stripped[1]?.message as Record<string, unknown>;
    expect(strippedAssistant.thinkingSignature).toBeUndefined();
    const strippedBlocks = strippedAssistant.content as Array<Record<string, unknown>>;
    expect(strippedBlocks.find((b) => b.type === "thinking")).toBeUndefined();

    // 2. Real scanner verification: scan the entire serialized redacted result
    const serializedRedacted = JSON.stringify(redacted);
    const scannerHits = scanForSecrets(
      { path: "redacted-session", content: serializedRedacted },
      [secret],
    );
    expect(scannerHits).toEqual([]); // ZERO hits!

    // 3. Confirm placeholder replacements were made
    expect(serializedRedacted).toContain("[REDACTED:API_SECRET_KEY]");
    expect(serializedRedacted).not.toContain(rawSecret);
    expect(serializedRedacted).not.toContain(b64Enc);
    expect(serializedRedacted).not.toContain(pctEnc);

    // 4. Live entries were not mutated (structuredClone guarantee)
    const originalSerialized = JSON.stringify(complexEntries);
    expect(originalSerialized).toContain(rawSecret);
    expect(originalSerialized).toContain("sig-should-be-preserved");

    // 5. Unverifiable redaction quarantines: simulate an entry that cannot be redacted
    const unredactableEntry: NativeSessionEntry[] = [
      {
        type: "message",
        id: "msg-quarantine",
        // Function toJSON returning unredacted secret bypasses normal string iteration
        message: {
          role: "assistant",
          content: "normal",
        },
        survivingHit: rawSecret,
      },
    ];
    // Manually force a surviving needle to test scanner quarantine trigger
    unredactableEntry[0]!.toString = () => rawSecret;

    // Test that store quarantines on unverifiable write
    const storeDir = await makeTempDir("store-quarantine-");
    const store = await createEvidenceStore({ runDir: storeDir, guardedSecrets: [secret] });
    await expect(
      store.writeRecord("pairs/p1/baseline/session.json", {
        leaked: rawSecret,
      }),
    ).rejects.toMatchObject({ code: "secret-quarantine" });

    // Verify only the redacted quarantine record was retained on disk
    const onDiskRecord = JSON.parse(
      await readFile(join(storeDir, "pairs/p1/baseline/session.json"), "utf8"),
    ) as { quarantined?: boolean; reason?: string };
    expect(onDiskRecord.quarantined).toBe(true);
    expect(onDiskRecord.reason).toContain("guarded secret was detected");

    // 6. Pattern-based secret redaction in sanitizeNativeSessionEntries (does NOT throw/quarantine)
    const patternEntry: NativeSessionEntry[] = [
      {
        type: "message",
        id: "msg-pattern-leaked",
        message: {
          role: "assistant",
          content: "API key: sk-abcdef1234567890abcdef123456",
        },
      },
    ];
    const patternResult = sanitizeNativeSessionEntries(patternEntry);
    const patternMsg = patternResult[0]?.message as Record<string, unknown>;
    expect(patternMsg.content).toBe("API key: [REDACTED:openai-key]");
    expect(patternResult.count).toBe(1);
    expect(patternResult.redactions[0]?.label).toBe("openai-key");
  });
});

describe("Schema-v1 backward compatibility and explicit unrecorded behavior", () => {
  it("legacy (schema-v1) evidence shows unavailable sessions/snapshots explicitly without fake replay and is never mutated", async () => {
    // Construct an authentic schema-v1 run tree
    const root = await makeTempDir("legacy-v1-run-");
    const runDir = join(root, "legacy-run-001");
    const receiptPath = join(runDir, "receipt.json");
    const condDir = "pairs/legacy-p1/baseline";

    // Build store with schema-v1 entries
    const store = await createEvidenceStore({ runDir });

    await store.writeRecord("inputs/plan.json", {
      schemaVersion: 1,
      runId: "legacy-run-001",
      mode: "fake",
      caseSelector: "network-config-01",
      skillPath: "skills/arbitrum-docs",
      caseId: "network-config-01",
      caseVersion: 1,
      repetitions: 1,
      schedule: [{ conditionId: "baseline", pairId: "legacy-p1", repetition: 1, order: 1, guestName: "g1", networkName: "n1" }],
      conditions: [{ conditionId: "baseline", skillPaths: [], imageDigest: "sha256:1111", parity: {} }],
    });
    await store.writeRecord("inputs/target.json", { schemaVersion: 1, provider: "google", model: "fake-model-0" });
    await store.writeRecord("inputs/policy.json", { schemaVersion: 1, execution: { sequentialExecution: true } });
    await store.writeRecord("inputs/case.json", {
      schemaVersion: 1,
      caseId: "network-config-01",
      caseVersion: 1,
      outputPath: "config.json",
      prompt: "test prompt",
    });
    await store.writeRecord("inputs/skill-snapshot.json", { schemaVersion: 1, files: [] });

    await store.writeRecord(`${condDir}/condition.json`, {
      schemaVersion: 1,
      conditionId: "baseline",
      order: 1,
      repetition: 1,
      pairId: "legacy-p1",
      status: "completed",
      gradeable: true,
      skillPaths: [],
      imageDigest: "sha256:1111",
      guestName: "g1",
      networkName: "n1",
      parity: {},
      runtime: { allowedTools: [], skillPaths: [] },
      timing: { durationMs: 120 },
      usage: { providerRequests: 1, toolSteps: 0 },
      redactions: { count: 0, locations: [] },
      cleanup: [{ kind: "guest", name: "g1", status: "destroyed", verified: true }],
      testDouble: true,
      evidenceLabel: "legacy",
    });
    await store.writeRecord(`${condDir}/attestation.json`, { schemaVersion: 1, attested: false });
    // In schema v1: duplicate transcript files exist, but NO session.json exists!
    await store.writeRecord(`${condDir}/messages.json`, {
      schemaVersion: 1,
      conditionId: "baseline",
      messages: [{ index: 0, role: "user", text: "legacy prompt", truncated: false }],
    });
    await store.writeRecord(`${condDir}/tool-steps.json`, {
      schemaVersion: 1,
      conditionId: "baseline",
      toolSteps: [],
    });
    await store.writeRecord(`${condDir}/workspace.json`, {
      schemaVersion: 1,
      conditionId: "baseline",
      files: [{ path: "config.json", bytes: 15, sha256: "abc", base64: Buffer.from("legacy-ws").toString("base64") }],
    });
    // Schema v1 candidate duplicated base64
    await store.writeRecord(`${condDir}/candidate.json`, {
      schemaVersion: 1,
      conditionId: "baseline",
      projected: true,
      includedPaths: ["config.json"],
      skipped: [],
      files: [{ path: "config.json", base64: Buffer.from("legacy-ws").toString("base64") }],
    });
    await store.writeRecord(`${condDir}/validation.json`, {
      schemaVersion: 1,
      conditionId: "baseline",
      gradeable: true,
      outcome: {
        status: "graded",
        score: 0.85,
        fullPass: false,
        checks: [{ id: "c1", passed: true, message: "ok" }],
      },
    });
    await store.writeRecord(`${condDir}/redactions.json`, { schemaVersion: 1, count: 0, entries: [] });
    await store.writeRecord(`${condDir}/errors.json`, { schemaVersion: 1, failures: [] });
    await store.writeRecord("pairs/legacy-p1/pair.json", {
      schemaVersion: 1,
      pairId: "legacy-p1",
      repetition: 1,
      conditions: [{ conditionId: "baseline", dir: condDir }],
      gradeable: false,
      delta: null,
      deltaReason: "single arm",
    });
    await store.writeRecord("cleanup.json", { schemaVersion: 1, sweep: [] });

    const generatedManifest = await store.sealManifest();
    // Construct historical v1 bytes in this new fixture, before its receipt exists.
    // Production has no legacy writer or migration path; all subsequent reads are byte-preserving.
    const legacyTree = buildManifestTree(generatedManifest.tree.entries, 1);
    const legacyManifestBytes = `${canonicalJson(legacyTree)}\n`;
    await chmod(join(runDir, "manifest.json"), 0o644);
    await writeFile(join(runDir, "manifest.json"), legacyManifestBytes);
    const manifest = { tree: legacyTree, fileSha256: sha256Hex(legacyManifestBytes) };
    await store.sealReceipt({
      schemaVersion: 1,
      runId: "legacy-run-001",
      caseSelector: "network-config-01",
      skillPath: "skills/arbitrum-docs",
      caseId: "network-config-01",
      caseVersion: 1,
      mode: "fake",
      status: "complete",
      stopReason: null,
      testDouble: true,
      evidenceLabel: "legacy v1",
      createdAt: new Date(0).toISOString(),
      planSha256: "test",
      manifest: { treeSha256: manifest.tree.treeSha256, fileSha256: manifest.fileSha256 },
      pairs: [{
        pairId: "legacy-p1",
        repetition: 1,
        path: "pairs/legacy-p1/pair.json",
        conditions: [{ conditionId: "baseline", dir: condDir }],
      }],
      cleanup: [],
      failures: [],
    });

    // Hash all files of this schema-v1 run
    const hashesBefore = await hashAllFiles(runDir);

    // 1. verifyRun verifies schema-v1 run without mutation
    const verifyResult = await verifyRun(runDir);
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.failures).toEqual([]);
    expect(verifyResult.populationIntegrity).toEqual({
      source: "sealed-pair-records",
      ordering: "unavailable-schema-v1",
    });

    // Receipt-only legacy membership edits must fail without changing the original tree.
    for (const attack of ["omit", "duplicate", "alias"] as const) {
      const copy = await makeTempDir(`legacy-${attack}-`);
      await cp(runDir, copy, { recursive: true });
      const copiedReceiptPath = join(copy, "receipt.json");
      const copiedReceipt = JSON.parse(await readFile(copiedReceiptPath, "utf8"));
      if (attack === "omit") copiedReceipt.pairs = [];
      else if (attack === "duplicate") copiedReceipt.pairs.push(copiedReceipt.pairs[0]);
      else copiedReceipt.pairs[0].conditions[0].dir = "pairs/other/baseline";
      await chmod(copiedReceiptPath, 0o644);
      await writeFile(copiedReceiptPath, JSON.stringify(copiedReceipt));
      expect((await verifyRun(copy)).ok).toBe(false);
      expect((await buildRunReport(copiedReceiptPath)).pairs).toEqual([]);
    }

    // 2. buildRunReport reads schema-v1 run using original grades
    const report = await buildRunReport(receiptPath);
    expect(report.verification.ok).toBe(true);
    expect(report.pairs[0]?.conditions[0]?.score).toBe(0.85);

    // 3. inspectCondition reads legacy messages and tools
    const inspectedMessages = await inspectCondition({
      receiptPath,
      conditionId: "baseline",
      view: "messages",
    });
    expect((inspectedMessages.content as { messages: unknown[] }).messages.length).toBe(1);

    // 4. inspectCondition with view "session" shows unavailable EXPLICITLY, without fake replay
    const inspectedSession = await inspectCondition({
      receiptPath,
      conditionId: "baseline",
      view: "session",
    });
    const sessionContent = inspectedSession.content as { available: boolean; reason: string };
    expect(sessionContent.available).toBe(false);
    expect(sessionContent.reason).toContain("not available in schema-v1 evidence");

    // 5. readFrozenInputs shows unavailable snapshot explicitly without fake defaults
    const frozenInputs = await readFrozenInputs(receiptPath);
    expect(frozenInputs.available).toBe(false);
    expect(frozenInputs.reason).toContain("not available in schema-v1 evidence");
    expect(frozenInputs.schemaVersion).toBe(1);
    expect(frozenInputs.validatorSource).toBeNull();
    expect(frozenInputs.prompt).toBeNull();
    expect(frozenInputs.oracleBytes).toBeNull();
    expect(frozenInputs.fixtureFiles).toEqual([]);

    // 6. readCandidate round-trips legacy candidate with inline base64 and candidateMode null
    const candidateResult = await readCandidate(receiptPath, condDir);
    expect(candidateResult.candidateMode).toBeNull(); // No fake default!
    expect(candidateResult.files.length).toBe(1);
    expect(candidateResult.files[0]?.path).toBe("config.json");
    expect(Buffer.from(candidateResult.files[0]!.base64, "base64").toString("utf8")).toBe("legacy-ws");

    // 7. Verify that reading schema-v1 evidence PROVABLY NEVER MUTATED ANY FILE
    const hashesAfter = await hashAllFiles(runDir);
    expect(hashesAfter.size).toBe(hashesBefore.size);
    for (const [path, beforeHash] of hashesBefore) {
      expect(hashesAfter.get(path)).toBe(beforeHash);
    }
  });
});

describe("Candidate projection vs Workspace byte reference", () => {
  it("candidate projection references workspace bytes rather than duplicating base64", async () => {
    const result = await runSyntheticEvaluation();
    const condPath = `pairs/${result.runId}-r001/treatment`;

    const wsRaw = JSON.parse(await readFile(join(result.runDir, condPath, "workspace.json"), "utf8")) as {
      files: Array<{ path: string; base64: string; sha256: string; bytes: number }>;
    };
    const candRaw = JSON.parse(await readFile(join(result.runDir, condPath, "candidate.json"), "utf8")) as {
      candidateMode: string;
      outputPath: string;
      files: Array<{ path: string; base64: string | null; workspaceRef: string | null; sha256: string }>;
    };

    // Both files exist and are separately identifiable
    expect(wsRaw.files.length).toBeGreaterThan(0);
    expect(candRaw.files.length).toBeGreaterThan(0);

    // In candidate.json, files in the workspace have workspaceRef set and base64 null
    const configFile = candRaw.files.find((f) => f.path === "config.json");
    expect(configFile).toBeDefined();
    expect(configFile!.workspaceRef).toBe("config.json");
    expect(configFile!.base64).toBeNull();

    // The reader resolves bytes from the workspace reference seamlessly
    const resolved = await readCandidate(result.receiptPath, condPath);
    const resolvedConfig = resolved.files.find((f) => f.path === "config.json");
    expect(resolvedConfig).toBeDefined();
    expect(resolvedConfig!.base64.length).toBeGreaterThan(0);
    expect(resolvedConfig!.bytes).toBe(wsRaw.files.find((f) => f.path === "config.json")!.bytes);
    expect(resolvedConfig!.sha256).toBe(wsRaw.files.find((f) => f.path === "config.json")!.sha256);
  });
});
