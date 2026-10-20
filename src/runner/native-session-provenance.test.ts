/**
 * Regression test for Pi SDK native session provenance, redaction, and retention.
 *
 * Exercises:
 * 1. createPiHarness + createFakeSandbox + real createAgentSession + tools with scripted stream.
 * 2. Exact correspondence between observed live SDK IDs/parents/toolcall-results and sealed session.json.
 * 3. Real file effect executed by SDK tools on the sandbox workspace.
 * 4. Actual receipt verification and reporting over sealed immutable evidence.
 * 5. Thinking blocks and signatures preserved verbatim; verifiable redaction of echoed secrets (gradeable).
 * 6. Guarantee that live SDK session state is never mutated by redaction.
 * 7. Quarantine fault stopping future repetitions and cancelling run-wide dispatch.
 * 8. Preservation of partial prefix after verified task-limit stop.
 * 9. Honest unavailable status when native entries are absent (e.g. from fake harness).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRunReport,
  inspectCondition,
  exportNativeSessionView,
  readNativeSession,
  verifyRun,
} from "../artifacts/queries.ts";
import { NATIVE_PREFIX_MAX_RECORD_BYTES } from "../artifacts/native-prefix.ts";
import { runIdFor } from "../core/experiment.ts";
import type { GuardedSecret } from "../core/secret-scan.ts";
import { createFakeHarness } from "../harnesses/fake.ts";
import { createPiHarness } from "../harnesses/pi/adapter.ts";
import {
  exportSessionFileToHtml,
  verifyExportedHtml,
  type NativeSessionEntry,
} from "../harnesses/pi/export-viewer.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createScriptedStreamSimple } from "../harnesses/pi/scripted-stream.ts";
import type { PiSdkSessionInstance } from "../harnesses/pi/sdk-session.ts";
import { FROZEN_TARGET } from "./models.ts";
import { runPairedEvaluation } from "./run.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { createInProcessValidatorRunner } from "./validation.ts";
import { installTestGuards } from "../test-guards.ts";

const repoRoot = process.cwd();
const evalsRoot = repoRoot;

describe("Native session provenance, redaction, and retention regression (L1)", () => {
  let tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    installTestGuards();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // cleanup best effort
      }
    }
    tempDirs = [];
  });

  it("proves real SDK entry IDs, parents, tool effects, preserved thinking, and secret redaction survive runner sealing", async () => {
    const root = makeTempDir("native-prov-");
    const workDir = makeTempDir("native-prov-work-");
    const secretValue = "top-secret-canary-key-4242";
    const guardedSecrets: GuardedSecret[] = [{ label: "CANARY_KEY", value: secretValue }];

    // Multi-turn scripted model sequence:
    // Turn 1: toolCall 'write' to create 'output.json' containing the answer and echoing the secret
    // Turn 2: toolCall 'read' to verify 'output.json'
    // Turn 3: assistant final response with private thinking block + signature, and text echoing secret
    const scriptedSteps = [
      {
        type: "toolCall",
        toolCalls: [
          {
            id: "call_write_sol_1",
            name: "write",
            arguments: {
              path: "output.json",
              content: JSON.stringify({ status: "success", secretRef: secretValue }),
            },
          },
        ],
      },
      {
        type: "toolCall",
        toolCalls: [
          {
            id: "call_read_sol_2",
            name: "read",
            arguments: { path: "output.json" },
          },
        ],
      },
      {
        type: "thinking",
        thinking: "hidden-private-chain-of-thought-reasoning-needle",
        signature: "private-thinking-signature-sig123",
        text: `Task completed. Echoing secret for test: ${secretValue}`,
      },
    ] as const;

    let capturedBaselineInstance: PiSdkSessionInstance | null = null;
    let liveBaselineEntriesBeforeSanitize: readonly NativeSessionEntry[] = [];
    let liveMessagesBeforeSanitize: readonly unknown[] = [];

    const harness = createPiHarness({
      streamSimpleOverrideFactory: () => createScriptedStreamSimple(scriptedSteps),
      onSessionCreated: (instance) => {
        if (!capturedBaselineInstance) {
          capturedBaselineInstance = instance;
          // Subscribe to capture the live state just as prompt settles, before any runner sanitization
          instance.session.subscribe((event: any) => {
            if (event.type === "agent_settled") {
              liveBaselineEntriesBeforeSanitize = instance.getNativeSessionEntries();
              liveMessagesBeforeSanitize = structuredClone(instance.session.messages as any);
            }
          });
        }
      },
    });

    const runId = runIdFor(new Date(1700000000000), "0123456789ab");
    const result = await runPairedEvaluation({
      evalsRoot,
      repoRoot,
      caseSelector: "network-config-01",
      skillPath: "skills/arbitrum-docs",
      mode: "fake",
      repetitions: 1,
      cliLimits: { wallClockMs: 60_000 },
      target: FROZEN_TARGET,
      runId,
      resourceNonce: "0a1b2c3d",
      createdAt: new Date(1700000000000).toISOString(),
      source: { revision: "a".repeat(40), dirty: false },
      evaluatorBuild: "evals-src@regression",
      harness,
      sandbox: createFakeSandbox(),
      validatorRunner: createInProcessValidatorRunner(),
      workDir,
      runsRoot: join(root, "runs"),
      stateDir: join(root, ".state"),
      guardedSecrets,
      captureReasoning: true,
      credentials: guardedSecrets.map((s) => ({
        variable: s.label,
        value: s.value,
      })),
    });

    expect(result.status).toBe("complete");

    // 1. Real receipt verification over immutable sealed evidence
    const verifyResult = await verifyRun(result.runDir);
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.failures).toEqual([]);
    expect(verifyResult.missing).toEqual([]);
    expect(verifyResult.extra).toEqual([]);
    expect(verifyResult.altered).toEqual([]);

    const report = await buildRunReport(result.receiptPath);
    expect(report.verification.ok).toBe(true);

    // 2. Sealed session inspection via readNativeSession
    const baselineSession = await readNativeSession(result.receiptPath, `pairs/${result.runId}-r001/baseline`);
    expect(baselineSession.available).toBe(true);
    expect(baselineSession.completed).toBe(true);
    expect(baselineSession.incompleteTail).toBe(false);
    expect(baselineSession.tailStatus).toBe("completed");
    expect(baselineSession.reasoningCaptured).toBe(true);

    const sealedEntries = baselineSession.entries as NativeSessionEntry[];
    expect(sealedEntries.length).toBeGreaterThanOrEqual(4);

    // 3. The first sealed record is the ACTUAL SDK header, compared directly to
    // SessionManager.getHeader(), not to the wrapper under test. Remaining records
    // correspond exactly to SessionManager.getEntries() (which excludes the header).
    expect(capturedBaselineInstance).not.toBeNull();
    const actualHeader = capturedBaselineInstance!.session.sessionManager.getHeader();
    const actualTreeEntries = capturedBaselineInstance!.session.sessionManager.getEntries();
    expect(actualHeader).not.toBeNull();
    expect(sealedEntries[0]).toEqual(actualHeader);
    expect(baselineSession.header).toEqual(actualHeader);
    expect(baselineSession.treeEntries).toEqual(sealedEntries.slice(1));
    expect(sealedEntries[0]!.type).toBe("session");
    expect(sealedEntries.slice(1)).toHaveLength(actualTreeEntries.length);
    expect(liveBaselineEntriesBeforeSanitize.length).toBeGreaterThan(1);
    expect(sealedEntries.length).toBe(liveBaselineEntriesBeforeSanitize.length);

    // Public export reuses this verified native read model and Pi's pinned exporter.
    const exportedView = await exportNativeSessionView({ receiptPath: result.receiptPath, conditionId: "baseline", format: "both" });
    expect(readFileSync(exportedView.jsonlPath, "utf8").split("\n")[0]).toContain('"type":"session"');
    expect(verifyExportedHtml(exportedView.htmlPath!).valid).toBe(true);
    expect((await verifyRun(result.runDir)).recomputedTreeSha256).toBe(verifyResult.recomputedTreeSha256);

    for (let i = 0; i < actualTreeEntries.length; i++) {
      const sealed = sealedEntries[i + 1]!;
      const live = actualTreeEntries[i] as NativeSessionEntry;

      // SDK-generated tree IDs, parents, types, and timestamps must match exactly.
      expect(sealed.id).toBe(live.id);
      expect(sealed.parentId).toBe(live.parentId);
      expect(sealed.type).toBe(live.type);
      expect(sealed.timestamp).toBe(live.timestamp);
      if (live.message?.role === "toolResult") {
        expect(sealed.message?.toolCallId).toBe(live.message.toolCallId);
        expect(sealed.message?.isError).toBe(live.message.isError);
      }
    }

    // 4. ParentId chain integrity: every non-root entry's parentId references an existing prior entry
    const entryIds = new Set<string>();
    for (let i = 0; i < sealedEntries.length; i++) {
      const entry = sealedEntries[i]!;
      if (entry.id) {
        entryIds.add(entry.id);
      }
      if (i > 0 && entry.parentId) {
        expect(entryIds.has(entry.parentId)).toBe(true);
      }
    }

    // 5. Toolcall and toolresult correspondence: toolCallId matches across message turns
    const writeCallEntry = sealedEntries.find(
      (e) =>
        e.type === "message" &&
        Array.isArray((e.message as any)?.content) &&
        (e.message as any).content.some((b: any) => b.type === "toolCall" && b.id === "call_write_sol_1"),
    );
    expect(writeCallEntry).toBeDefined();

    const writeResultEntry = sealedEntries.find(
      (e) =>
        e.type === "message" &&
        ((e.message as any)?.toolCallId === "call_write_sol_1" ||
          (Array.isArray((e.message as any)?.content) &&
            (e.message as any).content.some((b: any) => b.type === "toolResult" && b.toolCallId === "call_write_sol_1"))),
    );
    expect(writeResultEntry).toBeDefined();
    // The result's parent must be the tool call entry
    expect(writeResultEntry!.parentId).toBe(writeCallEntry!.id);

    // 6. Private reasoning, thinking blocks, and signatures are preserved verbatim - the
    // sealed session is Pi's raw native session; only secret values are ever changed.
    const serializedSealed = JSON.stringify(sealedEntries);
    expect(serializedSealed).toContain("hidden-private-chain-of-thought-reasoning-needle");
    expect(serializedSealed).toContain("private-thinking-signature-sig123");
    const finalAssistantEntry = sealedEntries.find(
      (e) =>
        e.message &&
        typeof e.message === "object" &&
        Array.isArray((e.message as any).content) &&
        (e.message as any).content.some(
          (b: any) => b.type === "thinking" && b.thinkingSignature === "private-thinking-signature-sig123",
        ),
    );
    expect(finalAssistantEntry).toBeDefined();

    // 7. Verified secret redaction: condition remains gradeable, secret byte absent from evidence
    expect(serializedSealed).toContain("[REDACTED:CANARY_KEY]");
    expect(serializedSealed).not.toContain(secretValue);

    // Explicit gradeability assertion
    const baselineReport = report.pairs[0]!.conditions.find((c) => c.conditionId === "baseline")!;
    expect(baselineReport.gradeable).toBe(true);
    expect(baselineReport.status).toBe("completed");

    const conditionJson = JSON.parse(
      readFileSync(join(result.runDir, `pairs/${result.runId}-r001/baseline/condition.json`), "utf8"),
    );
    expect(conditionJson.gradeable).toBe(true);
    expect(conditionJson.status).toBe("completed");

    // Honest session-specific redactions recorded in session.json
    expect(baselineSession.redactions.count).toBeGreaterThanOrEqual(1);
    expect(baselineSession.redactions.locations.some((l: string) => l.startsWith("session:"))).toBe(true);

    // 8. Real file effect: tool 'write' created output.json in the workspace
    const inspectedWs = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "baseline",
      view: "workspace",
    });
    expect(inspectedWs.verified).toBe(true);
    const wsFiles = (inspectedWs.content as any).files as Array<{ path: string; base64?: string }>;
    const writtenFile = wsFiles.find((f) => f.path === "output.json");
    expect(writtenFile).toBeDefined();
    expect(writtenFile!.base64).toBeDefined();
    const text = Buffer.from(writtenFile!.base64!, "base64").toString("utf8");
    expect(text).toContain("[REDACTED:CANARY_KEY]");

    // 9. No live state mutation: inspect actual live state via captured SDK instance
    expect(capturedBaselineInstance).not.toBeNull();
    const liveBaselineEntries = capturedBaselineInstance!.getNativeSessionEntries();
    expect(liveBaselineEntries.length).toBeGreaterThan(0);
    const serializedLive = JSON.stringify(liveBaselineEntries);
    expect(serializedLive).toContain(secretValue);
    const serializedMsgs = JSON.stringify(capturedBaselineInstance!.session.messages);
    expect(serializedMsgs).toContain("hidden-private-chain-of-thought-reasoning-needle");
    expect(serializedMsgs).toContain("private-thinking-signature-sig123");

    // 10. Inspect views dynamically derived from native session
    const inspectedMessages = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "baseline",
      view: "messages",
    });
    expect(inspectedMessages.verified).toBe(true);
    const msgs = (inspectedMessages.content as any).messages;
    expect(msgs.length).toBeGreaterThan(0);
    expect(JSON.stringify(msgs)).toContain("[REDACTED:CANARY_KEY]");
    expect(JSON.stringify(msgs)).not.toContain("hidden-private-chain-of-thought-reasoning-needle");

    const inspectedTools = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "baseline",
      view: "tools",
    });
    expect(inspectedTools.verified).toBe(true);
    const steps = (inspectedTools.content as any).toolSteps;
    expect(steps.some((s: any) => s.tool === "write")).toBe(true);
    expect(steps.some((s: any) => s.tool === "read")).toBe(true);

    // 11. Export the sealed, redacted full native records (header + tree) through
    // the pinned HTML exporter using only a disposable copy outside canonical evidence.
    const canonicalHashBeforeHtml = (await verifyRun(result.runDir)).recomputedTreeSha256;
    const disposableJsonl = join(result.runDir, "views", "baseline-native.jsonl");
    const disposableHtml = join(result.runDir, "views", "baseline-native.html");
    writeFileSync(disposableJsonl, `${sealedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await exportSessionFileToHtml(disposableJsonl, disposableHtml);
    const html = verifyExportedHtml(disposableHtml, {
      disallowedSecrets: [secretValue],
    });
    expect(html.valid).toBe(true);
    const exportedSession = html.decodedSessionJson as {
      header: NativeSessionEntry;
      entries: NativeSessionEntry[];
    };
    expect(exportedSession.header).toEqual(sealedEntries[0]);
    expect(exportedSession.entries).toHaveLength(actualTreeEntries.length);
    expect(JSON.stringify(exportedSession)).toContain("call_write_sol_1");
    expect(JSON.stringify(exportedSession)).toContain("call_read_sol_2");
    // Reasoning reaches the exported viewer too - the sealed session never stripped it,
    // and Pi's HTML template renders thinking blocks client-side from this embedded data.
    expect(JSON.stringify(exportedSession)).toContain("hidden-private-chain-of-thought-reasoning-needle");
    const afterHtml = await verifyRun(result.runDir);
    expect(afterHtml.ok).toBe(true);
    expect(afterHtml.recomputedTreeSha256).toBe(canonicalHashBeforeHtml);
    expect(existsSync(join(
      root,
      ".state/native-prefixes",
      `${runId}-${runId}-r001-baseline.jsonl`,
    ))).toBe(false);
  });

  it("preserves partial prefix after verified task-limit stop", async () => {
    const root = makeTempDir("partial-prefix-");
    const workDir = makeTempDir("partial-prefix-work-");

    // The first eligible tool executes; the native hook blocks N+1 and seals the prefix.
    const streamSimpleOverride = createScriptedStreamSimple([
      {
        type: "toolCall",
        toolCalls: [
          {
            id: "call_write_partial",
            name: "write",
            arguments: { path: "partial.txt", content: "partially written" },
          },
          {
            id: "call_write_blocked",
            name: "write",
            arguments: { path: "must-not-exist.txt", content: "blocked" },
          },
        ],
      },
    ]);

    let capturedBaselineInstance: PiSdkSessionInstance | null = null;
    let liveBaselineEntriesBeforeSanitize: readonly NativeSessionEntry[] = [];

    const harness = createPiHarness({
      streamSimpleOverride,
      onSessionCreated: (instance) => {
        if (!capturedBaselineInstance) {
          capturedBaselineInstance = instance;
          instance.session.subscribe((event: any) => {
            if (event.type === "agent_settled" || event.type === "turn_end") {
              liveBaselineEntriesBeforeSanitize = instance.getNativeSessionEntries();
            }
          });
        }
      },
    });
    const runId = runIdFor(new Date(1700000001000), "0123456789ac");

    const result = await runPairedEvaluation({
      evalsRoot,
      repoRoot,
      caseSelector: "network-config-01",
      skillPath: "skills/arbitrum-docs",
      mode: "fake",
      repetitions: 1,
      cliLimits: { maxToolSteps: 1, wallClockMs: 60_000 },
      target: FROZEN_TARGET,
      runId,
      resourceNonce: "0a1b2c3e",
      createdAt: new Date(1700000001000).toISOString(),
      source: { revision: "a".repeat(40), dirty: false },
      evaluatorBuild: "evals-src@regression",
      harness,
      sandbox: createFakeSandbox(),
      validatorRunner: createInProcessValidatorRunner(),
      workDir,
      runsRoot: join(root, "runs"),
      stateDir: join(root, ".state"),
    });

    // 1. Receipt verification
    const verifyResult = await verifyRun(result.runDir);
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.failures).toEqual([]);
    const report = await buildRunReport(result.receiptPath);
    expect(report.verification.ok).toBe(true);

    // 2. Both conditions stop on task-limit budget
    const session = await readNativeSession(result.receiptPath, `pairs/${result.runId}-r001/baseline`);
    expect(session.available).toBe(true);
    expect(session.completed).toBe(false);
    expect(session.incompleteTail).toBe(true);
    expect(session.tailStatus).toBe("truncated");

    // 3. Exact observed/sealed prefixes correspondence
    expect(liveBaselineEntriesBeforeSanitize.length).toBeGreaterThan(0);
    const sealedEntries = session.entries as NativeSessionEntry[];
    expect(sealedEntries.length).toBe(liveBaselineEntriesBeforeSanitize.length);
    for (let i = 0; i < sealedEntries.length; i++) {
      expect(sealedEntries[i]!.id).toBe(liveBaselineEntriesBeforeSanitize[i]!.id);
      expect(sealedEntries[i]!.parentId).toBe(liveBaselineEntriesBeforeSanitize[i]!.parentId);
      expect(sealedEntries[i]!.type).toBe(liveBaselineEntriesBeforeSanitize[i]!.type);
    }

    const hasWriteCall = sealedEntries.some(
      (e) => Array.isArray((e.message as any)?.content) && (e.message as any).content.some((b: any) => b.name === "write"),
    );
    expect(hasWriteCall).toBe(true);

    // 4. Gradeability and status check
    const baselineReport = report.pairs[0]!.conditions.find((c) => c.conditionId === "baseline")!;
    expect(baselineReport.gradeable).toBe(true);
    expect(baselineReport.status).toBe("task-limit");

    const conditionJson = JSON.parse(
      readFileSync(join(result.runDir, `pairs/${result.runId}-r001/baseline/condition.json`), "utf8"),
    );
    expect(conditionJson.gradeable).toBe(true);
    expect(conditionJson.status).toBe("task-limit");

    // 5. Cleanup verification
    const inspectedRuntime = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "baseline",
      view: "runtime",
    });
    expect(inspectedRuntime.verified).toBe(true);
    const cleanup = (inspectedRuntime.content as any).cleanup as Array<{ status: string; verified: boolean }>;
    expect(cleanup.length).toBeGreaterThan(0);
    expect(cleanup.every((c) => c.verified === true && (c.status === "destroyed" || c.status === "already-absent"))).toBe(true);
  });

  it("seals the exact earlier SDK tool prefix when a later native append exceeds the capture bound", async () => {
    const root = makeTempDir("oversize-prefix-");
    const workDir = makeTempDir("oversize-prefix-work-");
    const runId = runIdFor(new Date(1700000001500), "0123456789bd");
    const streamSimpleOverride = createScriptedStreamSimple([
      {
        type: "toolCall",
        toolCalls: [{
          id: "call_before_oversize",
          name: "write",
          arguments: { path: "before.txt", content: "durable before oversized append" },
        }],
      },
      { type: "text", text: "x".repeat(NATIVE_PREFIX_MAX_RECORD_BYTES) },
    ]);
    const sdkEntriesByArm = new Map<string, readonly NativeSessionEntry[]>();
    const dispatches: string[] = [];
    const baseHarness = createPiHarness({
      streamSimpleOverride,
      onSessionCreated: (instance) => {
        const arm = instance.attest().arm;
        instance.session.subscribe((event: any) => {
          if (event.type === "message_end") sdkEntriesByArm.set(arm, instance.getNativeSessionEntries());
        });
      },
    });
    const harness = {
      ...baseHarness,
      run: async (guest: any, request: any) => {
        dispatches.push(request.conditionId);
        return baseHarness.run(guest, request);
      },
    };

    const result = await runPairedEvaluation({
      evalsRoot,
      repoRoot,
      caseSelector: "network-config-01",
      skillPath: "skills/arbitrum-docs",
      mode: "fake",
      repetitions: 2,
      schedulingPolicy: "serial",
      cliLimits: { wallClockMs: 60_000 },
      target: FROZEN_TARGET,
      runId,
      resourceNonce: "0a1b2c4d",
      createdAt: new Date(1700000001500).toISOString(),
      source: { revision: "a".repeat(40), dirty: false },
      evaluatorBuild: "evals-src@regression",
      harness,
      sandbox: createFakeSandbox(),
      validatorRunner: createInProcessValidatorRunner(),
      workDir,
      runsRoot: join(root, "runs"),
      stateDir: join(root, ".state"),
    });

    expect(result.status).toBe("partial");
    expect(dispatches).toEqual(["baseline"]);
    expect(result.failures.some((failure) => failure.code === "evidence-invalid" && /record exceeds/.test(failure.message))).toBe(true);
    const verification = await verifyRun(result.runDir);
    expect(verification.ok).toBe(true);
    const prefix = await readNativeSession(result.receiptPath, `pairs/${runId}-r001/baseline`);
    expect(prefix.available).toBe(true);
    expect(prefix.completed).toBe(false);
    expect(prefix.incompleteTail).toBe(true);
    const sealed = prefix.entries as NativeSessionEntry[];
    expect(JSON.stringify(sealed)).toContain("call_before_oversize");
    expect(JSON.stringify(sealed)).toContain("toolResult");
    expect(JSON.stringify(sealed)).not.toContain("x".repeat(1024));
    const live = sdkEntriesByArm.get("baseline")!;
    expect(live.length).toBe(sealed.length + 1);
    expect(sealed.map((entry) => entry.id)).toEqual(live.slice(0, sealed.length).map((entry) => entry.id));

    const condition = JSON.parse(readFileSync(join(result.runDir, `pairs/${runId}-r001/baseline/condition.json`), "utf8"));
    const validation = JSON.parse(readFileSync(join(result.runDir, `pairs/${runId}-r001/baseline/validation.json`), "utf8"));
    expect(condition.status).toBe("infrastructure-failure");
    expect(condition.gradeable).toBe(false);
    expect(validation.outcome).toBeNull();
  });

  it("exercises real scripted SDK native sanitizer failure, stopping later dispatch, cancelling sibling, and disposing sessions", async () => {
    const root = makeTempDir("quarantine-prop-");
    const workDir = makeTempDir("quarantine-prop-work-");

    const runId = runIdFor(new Date(1700000002000), "0123456789ad");
    const secretValue = "quarantine-sdk-secret-key-9999";

    // Track exact created session instances and their arm identities
    const createdSessions: Array<{ arm: string; instance: PiSdkSessionInstance }> = [];
    const disposedInstances = new Set<PiSdkSessionInstance>();

    // Track exact harness run dispatches
    const dispatchedRuns: Array<{ conditionId: string; arm: string }> = [];

    // Controlled in-flight sibling prompt barrier: treatment prompt starts first and waits
    let resolveTreatmentInFlight!: () => void;
    const treatmentInFlightPromise = new Promise<void>((resolve) => {
      resolveTreatmentInFlight = resolve;
    });

    let treatmentPromptAbortObserved = false;
    let baselineInstance: PiSdkSessionInstance | null = null;
    let treatmentInstance: PiSdkSessionInstance | null = null;

    const baseHarness = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([
        {
          type: "text",
          text: `Executing model turn with secret: ${secretValue}`,
        },
      ]),
      faults: {
        simulateNativeSanitizerFailure: true,
        failConditionId: "baseline",
      },
      onSessionCreated: (instance) => {
        const arm = instance.attest().arm;
        createdSessions.push({ arm, instance });
        const origDispose = instance.dispose;
        (instance as any).dispose = () => {
          disposedInstances.add(instance);
          origDispose.call(instance);
        };

        if (arm === "treatment") {
          treatmentInstance = instance;
          // Hook treatment's model runtime stream to establish in-flight barrier and observe abort
          instance.modelRuntime.streamSimple = (_model, _context, options) => {
            const stream = createAssistantMessageEventStream();
            const onAbort = () => {
              treatmentPromptAbortObserved = true;
              const abortedMsg = {
                role: "assistant" as const,
                content: [],
                api: _model.api,
                provider: _model.provider,
                model: _model.id,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "aborted" as const,
                errorMessage: "Request was aborted",
                timestamp: Date.now(),
              };
              stream.push({ type: "error", reason: "aborted", error: abortedMsg });
              stream.end(abortedMsg);
            };

            if (options?.signal?.aborted) {
              onAbort();
            } else {
              options?.signal?.addEventListener("abort", onAbort, { once: true });
            }

            // Treatment prompt is now actively in-flight
            resolveTreatmentInFlight();
            return stream;
          };
        } else if (arm === "baseline") {
          baselineInstance = instance;
          instance.modelRuntime.streamSimple = (_model, _context, options) => {
            const stream = createAssistantMessageEventStream();
            queueMicrotask(async () => {
              // Barrier: wait until treatment sibling is actively in-flight in its prompt
              await treatmentInFlightPromise;

              const textMsg = {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: `Executing baseline turn with secret: ${secretValue}` }],
                api: _model.api,
                provider: _model.provider,
                model: _model.id,
                usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
              stream.push({ type: "done", reason: "stop", message: textMsg });
              stream.end(textMsg);
            });
            return stream;
          };
        }
      },
    });

    const harness = {
      ...baseHarness,
      run: async (guest: any, req: any) => {
        dispatchedRuns.push({ conditionId: req.conditionId, arm: req.conditionId });
        return baseHarness.run(guest, req);
      },
    };

    const result = await runPairedEvaluation({
      evalsRoot,
      repoRoot,
      caseSelector: "network-config-01",
      skillPath: "skills/arbitrum-docs",
      mode: "fake",
      repetitions: 2, // Request 2 repetitions
      schedulingPolicy: "overlap",
      cliLimits: { wallClockMs: 60_000 },
      target: FROZEN_TARGET,
      runId,
      resourceNonce: "0a1b2c3f",
      createdAt: new Date(1700000002000).toISOString(),
      source: { revision: "a".repeat(40), dirty: false },
      evaluatorBuild: "evals-src@regression",
      harness,
      sandbox: createFakeSandbox(),
      validatorRunner: createInProcessValidatorRunner(),
      workDir,
      runsRoot: join(root, "runs"),
      stateDir: join(root, ".state"),
      guardedSecrets: [{ label: "QUARANTINE_KEY", value: secretValue }],
      credentials: [{ variable: "QUARANTINE_KEY", value: secretValue }],
    });

    // 1. Baseline failure explicitly native sanitizer quarantine
    expect(result.status).toBe("partial");
    expect(result.stopReason).toContain("secret quarantine");
    expect(
      result.failures.some(
        (f) => f.code === "secret-quarantine" && f.at === "session:baseline" && f.message.includes("simulated failure in baseline"),
      ),
    ).toBe(true);

    const report = await buildRunReport(result.receiptPath);
    expect(
      report.failures?.some(
        (f) => f.code === "secret-quarantine" && f.at === "session:baseline" && f.message.includes("simulated failure in baseline"),
      ),
    ).toBe(true);

    const baselineCond = report.pairs[0]!.conditions.find((c) => c.conditionId === "baseline")!;
    expect(baselineCond.status).toBe("infrastructure-failure");
    expect(baselineCond.gradeable).toBe(false);

    // 2. Controlled sibling prompt cancellation: treatment abort observed in-flight
    expect(treatmentPromptAbortObserved).toBe(true);
    const treatmentCond = report.pairs[0]!.conditions.find((c) => c.conditionId === "treatment")!;
    expect(treatmentCond.status).toBe("infrastructure-failure");
    expect(treatmentCond.gradeable).toBe(false);

    // The runner promotes both durable prefixes after verified cleanup even though one
    // arm threw and the sibling was cancelled. No completed native append is lost.
    const baselinePrefix = await readNativeSession(result.receiptPath, `pairs/${result.runId}-r001/baseline`);
    const treatmentPrefix = await readNativeSession(result.receiptPath, `pairs/${result.runId}-r001/treatment`);
    expect(baselinePrefix.incompleteTail).toBe(true);
    expect(treatmentPrefix.incompleteTail).toBe(true);
    expect((baselinePrefix.entries as NativeSessionEntry[]).map((entry) => entry.id)).toEqual(
      baselineInstance!.getNativeSessionEntries().map((entry) => entry.id),
    );
    expect((treatmentPrefix.entries as NativeSessionEntry[]).map((entry) => entry.id)).toEqual(
      treatmentInstance!.getNativeSessionEntries().map((entry) => entry.id),
    );

    // 3. Exact created and dispatched arm+repetition identities (zero repetition 2 dispatches)
    expect(createdSessions.length).toBe(2);
    expect(createdSessions.map((s) => s.arm)).toEqual(["baseline", "treatment"]);

    expect(dispatchedRuns.length).toBe(2);
    expect(dispatchedRuns.map((r) => r.conditionId)).toEqual(["baseline", "treatment"]);

    // 4. Disposal verification: both created repetition 1 SDK sessions were properly disposed
    expect(baselineInstance).not.toBeNull();
    expect(treatmentInstance).not.toBeNull();
    expect(disposedInstances.has(baselineInstance!)).toBe(true);
    expect(disposedInstances.has(treatmentInstance!)).toBe(true);
  });

  it("sealing independently rescans and rejects surviving secret even when positive redaction count was supplied", async () => {
    const root = makeTempDir("seal-reject-");
    const workDir = makeTempDir("seal-reject-work-");
    const secretValue = "surviving-canary-secret-12345";
    const guardedSecrets: GuardedSecret[] = [{ label: "QUARANTINE_KEY", value: secretValue }];

    const baseHarness = createPiHarness({
      streamSimpleOverride: createScriptedStreamSimple([
        {
          type: "text",
          text: "Safe text response",
        },
      ]),
    });

    // Harness returns an entry with an unredactable key (surviving secret needle)
    // while falsely claiming a positive redaction count
    const harness = {
      ...baseHarness,
      run: async (guest: any, req: any) => {
        const res = await baseHarness.run(guest, req);
        return {
          ...res,
          nativeSessionEntries: [
            {
              type: "message",
              id: "msg-surviving-hit",
              // Object key containing the secret needle will survive deepSanitizeValue
              // and trigger scanForSecrets failure
              [secretValue]: "unredactable-property",
              message: { role: "assistant", content: "safe" },
            },
          ],
          nativeSessionRedactions: {
            count: 1, // Positive supplied count attempting to bypass sanitization
            entries: [{ path: "session:msg-surviving-hit", count: 1, label: "QUARANTINE_KEY", encoding: "raw" as const }],
          },
        };
      },
    };

    const runId = runIdFor(new Date(1700000004000), "0123456789af");
    await expect(
      runPairedEvaluation({
        evalsRoot,
        repoRoot,
        caseSelector: "network-config-01",
        skillPath: "skills/arbitrum-docs",
        mode: "fake",
        repetitions: 1,
        cliLimits: { wallClockMs: 60_000 },
        target: FROZEN_TARGET,
        runId,
        resourceNonce: "0a1b2c41",
        createdAt: new Date(1700000004000).toISOString(),
        source: { revision: "a".repeat(40), dirty: false },
        evaluatorBuild: "evals-src@regression",
        harness,
        sandbox: createFakeSandbox(),
        validatorRunner: createInProcessValidatorRunner(),
        workDir,
        runsRoot: join(root, "runs"),
        stateDir: join(root, ".state"),
        guardedSecrets,
        credentials: [{ variable: "QUARANTINE_KEY", value: secretValue }],
      }),
    ).rejects.toThrowError(/\[secret-quarantine\].*unverifiable secret redaction/);
    expect(existsSync(join(
      root,
      ".state/native-prefixes",
      `${runId}-${runId}-r001-baseline.jsonl`,
    ))).toBe(true);
  });

  it("tracks session-specific redactions honestly without double counting derived copies for session-only secret echo", async () => {
    const root = makeTempDir("session-only-prov-");
    const workDir = makeTempDir("session-only-prov-work-");
    const secretValue = "session-only-canary-secret-7777";
    const guardedSecrets: GuardedSecret[] = [{ label: "SESSION_KEY", value: secretValue }];

    // Scripted model turn: echoes secret in text ONLY, with NO file writes to workspace
    const harness = createPiHarness({
      streamSimpleOverrideFactory: () => createScriptedStreamSimple([
        {
          type: "text",
          text: `Echoing secret only in session transcript: ${secretValue}`,
        },
      ]),
    });
    const runId = runIdFor(new Date(1700000003000), "0123456789ae");

    const result = await runPairedEvaluation({
      evalsRoot,
      repoRoot,
      caseSelector: "network-config-01",
      skillPath: "skills/arbitrum-docs",
      mode: "fake",
      repetitions: 1,
      cliLimits: { wallClockMs: 60_000 },
      target: FROZEN_TARGET,
      runId,
      resourceNonce: "0a1b2c40",
      createdAt: new Date(1700000003000).toISOString(),
      source: { revision: "a".repeat(40), dirty: false },
      evaluatorBuild: "evals-src@regression",
      harness,
      sandbox: createFakeSandbox(),
      validatorRunner: createInProcessValidatorRunner(),
      workDir,
      runsRoot: join(root, "runs"),
      stateDir: join(root, ".state"),
      guardedSecrets,
      credentials: guardedSecrets.map((s) => ({
        variable: s.label,
        value: s.value,
      })),
    });

    expect(result.status).toBe("complete");

    // 1. Receipt verification
    const verifyResult = await verifyRun(result.runDir);
    expect(verifyResult.ok).toBe(true);
    expect(verifyResult.failures).toEqual([]);

    // 2. Condition is gradeable
    const report = await buildRunReport(result.receiptPath);
    expect(report.verification.ok).toBe(true);
    const baselineReport = report.pairs[0]!.conditions.find((c) => c.conditionId === "baseline")!;
    expect(baselineReport.gradeable).toBe(true);
    expect(baselineReport.status).toBe("completed");

    const conditionJson = JSON.parse(
      readFileSync(join(result.runDir, `pairs/${result.runId}-r001/baseline/condition.json`), "utf8"),
    );
    expect(conditionJson.gradeable).toBe(true);
    expect(conditionJson.status).toBe("completed");

    // 3. session.json reports honest non-zero session-specific redaction metadata
    const baselineSession = await readNativeSession(result.receiptPath, `pairs/${result.runId}-r001/baseline`);
    expect(baselineSession.available).toBe(true);
    expect(baselineSession.completed).toBe(true);
    expect(baselineSession.redactions.count).toBe(1);
    expect(baselineSession.redactions.locations.length).toBe(1);
    expect(baselineSession.redactions.locations[0]).toContain("session:");

    const sealedSerialized = JSON.stringify(baselineSession.entries);
    expect(sealedSerialized).toContain("[REDACTED:SESSION_KEY]");
    expect(sealedSerialized).not.toContain(secretValue);

    // 4. Workspace files have zero redactions
    const inspectedWs = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "baseline",
      view: "workspace",
    });
    expect(inspectedWs.verified).toBe(true);
    const wsFiles = (inspectedWs.content as any).files as Array<{ path: string; base64?: string }>;
    for (const f of wsFiles) {
      if (f.base64) {
        const text = Buffer.from(f.base64, "base64").toString("utf8");
        expect(text).not.toContain("[REDACTED:SESSION_KEY]");
      }
    }

    // 5. Condition-wide redactions: merged totals without counting derived copies twice
    // Exactly 1 redaction total across condition (session only, not derived messages copy)
    const inspectedRedactions = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "baseline",
      view: "redactions",
    });
    expect(inspectedRedactions.verified).toBe(true);
    expect((inspectedRedactions.content as any).count).toBe(1);
    expect((inspectedRedactions.content as any).entries.length).toBe(1);
    expect((inspectedRedactions.content as any).entries[0].path).toBe(baselineSession.redactions.locations[0]);

    expect(conditionJson.redactions.count).toBe(1);
    expect(conditionJson.redactions.locations.length).toBe(1);
    expect(conditionJson.redactions.locations[0]).toBe(baselineSession.redactions.locations[0]);

    // 6. Derived views (messages) show placeholder without double-counting
    const inspectedMessages = await inspectCondition({
      receiptPath: result.receiptPath,
      conditionId: "baseline",
      view: "messages",
    });
    expect(inspectedMessages.verified).toBe(true);
    const msgsText = JSON.stringify((inspectedMessages.content as any).messages);
    expect(msgsText).toContain("[REDACTED:SESSION_KEY]");
    expect(msgsText).not.toContain(secretValue);
  });
});
