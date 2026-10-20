import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPiHarness } from "../harnesses/pi/adapter.ts";
import type { Harness } from "../harnesses/harness.ts";
import { exportSessionFileToHtml, verifyExportedHtml } from "../harnesses/pi/export-viewer.ts";
import { createAppleContainerSandbox, runContainerCli } from "../sandboxes/apple-container.ts";
import type { Guest, Sandbox } from "../sandboxes/sandbox.ts";
import { createContainerValidatorRunner } from "./container-validator.ts";
import type { ValidatorRunner } from "./validation.ts";
import { buildFreshBoundaryCommand } from "./container-paired-boundary.ts";
import { readNativeSession, verifyRun } from "../artifacts/queries.ts";
import type { CasePreparer } from "../core/types.ts";
import type { RunProgressEvent } from "./run.ts";
import { runCli, type TestOnlyRunComposition } from "../../scripts/run.ts";

const [suiteId, policy, repetitionsText] = process.argv.slice(2);
const fault = process.env.EVALS_TEST_FAULT;
const allowedFaults = ["preparation", "export", "grading", "task-budget", "preparation-abort", "guest-preparation-abort", "tool-abort", "export-abort", "grading-abort"];
if (fault !== undefined && !allowedFaults.includes(fault)) throw new Error(`unsupported EVALS_TEST_FAULT: ${fault}`);
const abortStage = fault?.endsWith("-abort") ? fault.slice(0, -6) as "preparation" | "guest-preparation" | "tool" | "export" | "grading" : null;
const repetitions = Number(repetitionsText);
if (!suiteId || (policy !== "serial" && policy !== "overlap") || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 2) throw new Error("usage: child <suite> <serial|overlap> <1|2>");
const secret = `paired-synthetic-canary-${suiteId}`;
const markerDir = process.env.EVALS_ABORT_MARKER_DIR;
const timingEnabled = process.env.EVALS_PAIRED_TIMING_CHILD === "1";
const measurements: Record<string, Array<{ label: string; ms: number }>> = {};
const progress: RunProgressEvent[] = [];
// This intentionally brackets the test child's wider invocation window, including
// wrapper/composition setup and result-marker emission; it is not exact runCli latency.
const childInvocationStartedAtMs = Date.now();

function record(metric: string, label: string, startedAtMs: number): void {
  (measurements[metric] ??= []).push({ label, ms: Date.now() - startedAtMs });
}

function conditionLabel(name: string): string {
  return name.includes("baseline") ? "baseline" : name.includes("treatment") ? "treatment" : name;
}

function measuredGuest(guest: Guest): Guest {
  return new Proxy(guest, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const metric = property === "stage" ? "workspaceStageMs"
        : property === "attest" ? "guestAttestationMs"
        : property === "deliverCredential" ? "credentialDeliveryMs"
        : property === "exportFiles" ? "workspaceExportMs"
        : property === "destroy" ? "agentGuestCleanupMs" : null;
      if (metric === null) return value.bind(target);
      return async (...args: unknown[]) => {
        const started = Date.now();
        try { return await value.apply(target, args); }
        finally { record(metric, conditionLabel(target.name), started); }
      };
    },
  });
}

function measuredSandbox(base: Sandbox): Sandbox {
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "createGuest") {
        return async (...args: unknown[]) => {
          const started = Date.now();
          try { return measuredGuest(await value.apply(target, args)); }
          finally { record("guestCreateMs", conditionLabel((args[0] as { name: string }).name), started); }
        };
      }
      const metric = property === "buildImage" ? "imageAcquireInspectMs"
        : property === "createNetwork" ? "networkCreateMs"
        : property === "destroyNetwork" || property === "destroyResource" ? "agentResourceCleanupMs" : null;
      if (metric === null) return value.bind(target);
      return async (...args: unknown[]) => {
        const started = Date.now();
        try { return await value.apply(target, args); }
        finally { record(metric, typeof args[0] === "string" ? conditionLabel(args[0]) : String(property), started); }
      };
    },
  });
}

function measuredHarness(base: Harness): Harness {
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const metric = property === "attest" ? "harnessAttestationMs" : property === "run" ? "sdkExecutionMs" : null;
      if (metric === null) return value.bind(target);
      return async (...args: unknown[]) => {
        const started = Date.now();
        const request = args[1] as { conditionId?: string } | undefined;
        try { return await value.apply(target, args); }
        finally { record(metric, request?.conditionId ?? "unknown", started); }
      };
    },
  });
}

function measuredValidator(base: ValidatorRunner): ValidatorRunner {
  return new Proxy(base, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "run" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const started = Date.now();
        try { return await value.apply(target, args); }
        finally { record("validatorLifecycleMs", `grader-${(measurements.validatorLifecycleMs?.length ?? 0) + 1}`, started); }
      };
    },
  });
}

async function makeCliWrapper(): Promise<string | undefined> {
  if (abortStage === null || markerDir === undefined || abortStage === "preparation") return undefined;
  await mkdir(markerDir, { recursive: true });
  const realCli = execFileSync("/usr/bin/which", ["container"], { encoding: "utf8" }).trim();
  const wrapper = join(markerDir, "container-wrapper.sh");
  const script = `#!/bin/bash
set -u
real=${JSON.stringify(realCli)}
marker=${JSON.stringify(markerDir)}
stage=${JSON.stringify(abortStage)}
match=0
case "$stage" in
  guest-preparation) [[ " $* " == *" run --detach --name "* ]] && match=1 ;;
  tool) [[ " $* " == *" /opt/eval/run-measured.mjs agent "* ]] && match=1 ;;
  export) [[ " $* " == *" /opt/eval/run-measured.mjs export "* ]] && match=1 ;;
  grading) [[ " $* " == *" /opt/eval/run-measured.mjs validate "* ]] && match=1 ;;
esac
if [[ "$stage" == guest-preparation && $match -eq 1 ]]; then
  guest=""
  want_name=0
  for argument in "$@"; do
    if [[ $want_name -eq 1 ]]; then guest="$argument"; want_name=0; fi
    [[ "$argument" == --name ]] && want_name=1
  done
  out="$marker/create.stdout"
  err="$marker/create.stderr"
  "$real" "$@" >"$out" 2>"$err"
  status=$?
  if [[ $status -ne 0 ]]; then cat "$out"; cat "$err" >&2; exit "$status"; fi
  if [[ -z "$guest" ]] || ! "$real" inspect "$guest" >/dev/null 2>&1; then
    cat "$out"; cat "$err" >&2; exit 97
  fi
  fifo="$marker/release.fifo"
  mkfifo "$fifo"
  printf '{"stage":"%s","wrapperPid":%s,"operationPid":%s,"resourceKind":"guest","resource":"%s"}\n' "$stage" "$$" "$$" "$guest" > "$marker/process.json"
  trap 'exit 130' TERM INT
  read -r _release < "$fifo"
  cat "$out"
  cat "$err" >&2
  exit 0
fi
"$real" "$@" <&0 &
pid=$!
if [[ $match -eq 1 ]]; then
  if [[ "$stage" == tool ]]; then
    printf '{"stage":"%s","wrapperPid":%s,"operationPid":%s}\n' "$stage" "$$" "$pid" > "$marker/process.json"
  else
    guest=""
    previous=""
    want_name=0
    for argument in "$@"; do
      if [[ $want_name -eq 1 ]]; then guest="$argument"; want_name=0; fi
      [[ "$argument" == --name ]] && want_name=1
      if [[ "$argument" == node && -z "$guest" ]]; then guest="$previous"; fi
      previous="$argument"
    done
    detected=0
    for _attempt in {1..500}; do
      if [[ "$stage" == export ]]; then
        probe='for f in /proc/[0-9]*/cmdline; do c=$(tr "\\000" " " < "$f" 2>/dev/null); case "$c" in *run-measured.mjs\\ export*) p=\${f#/proc/}; p=\${p%/cmdline}; kill -STOP "$p"; exit 0;; esac; done; exit 1'
      else
        probe='for f in /proc/[0-9]*/cmdline; do c=$(tr "\\000" " " < "$f" 2>/dev/null); case "$c" in *run-measured.mjs\\ validate*) exit 0;; esac; done; exit 1'
      fi
      if "$real" exec "$guest" /bin/sh -c "$probe" >/dev/null 2>&1; then detected=1; break; fi
    done
    if [[ $detected -ne 1 ]]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; exit 97; fi
    printf '{"stage":"%s","wrapperPid":%s,"operationPid":%s}\n' "$stage" "$$" "$pid" > "$marker/process.json"
  fi
fi
trap 'kill -TERM "$pid" 2>/dev/null || true; sleep 0.05; kill -KILL "$pid" 2>/dev/null || true' TERM INT EXIT
wait "$pid"
status=$?
trap - TERM INT EXIT
exit "$status"
`;
  await writeFile(wrapper, script, "utf8");
  await chmod(wrapper, 0o700);
  return wrapper;
}

const cliPath = await makeCliWrapper();
const usage = { input: 7, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const scriptedSteps = [
  { type: "toolCall" as const, toolCalls: [{ id: "assert-fresh-agent-boundary", name: "bash", arguments: { command: buildFreshBoundaryCommand({ suiteId }) } }], usage },
  { type: "toolCall" as const, toolCalls: [{ id: "write-result", name: "write", arguments: { path: "nested/result.txt", content: "placeholder" } }], usage },
  { type: "toolCall" as const, toolCalls: [{ id: "read-classification", name: "read", arguments: { path: "nested-result.tmp" } }], usage },
  { type: "toolCall" as const, toolCalls: [{ id: "install-classification", name: "bash", arguments: { command: "cat nested-result.tmp > nested/result.txt; rm nested-result.tmp; printf draft > companion.txt" } }], usage },
  { type: "toolCall" as const, toolCalls: [{ id: "edit-companion", name: "edit", arguments: { path: "companion.txt", oldText: "draft", newText: "preserved" } }], usage },
  { type: "text" as const, text: "Synthetic workspace completed.", usage },
];
const toolAbortSteps = [
  { type: "toolCall" as const, toolCalls: [{ id: "in-flight-bash", name: "bash", arguments: { command: "printf entered > .abort-tool-entered; sleep 120; printf late > .abort-tool-late" } }], usage },
  { type: "text" as const, text: "must not be dispatched after interruption", usage },
];
const exportAbortSteps = [
  { type: "toolCall" as const, toolCalls: [{ id: "prepare-live-export", name: "bash", arguments: { command: "i=0; while [ $i -lt 30 ]; do head -c 60000 /dev/zero | tr '\\000' x > export-$i.bin; i=$((i+1)); done" } }], usage },
  { type: "text" as const, text: "large bounded export fixture ready", usage },
];
const effectiveSteps = fault === "task-budget"
  ? [{ type: "stop" as const, stopReason: "length" as const, text: "bounded partial output", usage }]
  : abortStage === "tool" ? toolAbortSteps : abortStage === "export" ? exportAbortSteps : scriptedSteps;

const preparer: CasePreparer | undefined = fault === "preparation" ? async () => { throw new Error("injected trusted preparation failure"); }
  : abortStage === "preparation" ? async ({ signal }) => {
      if (markerDir === undefined) throw new Error("preparation abort marker directory missing");
      await mkdir(markerDir, { recursive: true });
      const resource = `eval-prep-abort-${randomBytes(4).toString("hex")}`;
      const labels = ["--label", `eval-test=${suiteId}`, "--label", "eval-stage=preparation-abort"];
      const created = await runContainerCli(["network", "create", ...labels, resource], { signal, timeoutMs: 30_000 });
      if (created.code !== 0) throw new Error(`could not create preparation resource: ${created.stderr}`);
      try {
        await writeFile(join(markerDir, "process.json"), JSON.stringify({ stage: "preparation", resourceKind: "network", resource }), "utf8");
        return await new Promise<never>((_resolve, reject) => {
          const stop = () => reject(signal.reason ?? new Error("preparation interrupted"));
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
        });
      } finally {
        await runContainerCli(["network", "delete", resource], { timeoutMs: 30_000 });
      }
    } : undefined;

const composition: TestOnlyRunComposition = {
  testOnly: true,
  guardedSecrets: [{ label: "GEMINI_API_KEY", value: secret }],
  credentials: [{ variable: "GEMINI_API_KEY", value: secret }],
  stateDir: join(process.cwd(), "evals", ".state", suiteId),
  ...(preparer === undefined ? {} : { preparer }),
  ...(fault === "export" ? { faults: { simulateSurvivingSecretHit: true } } : {}),
  ...(timingEnabled ? { onProgress: (event: RunProgressEvent) => progress.push(event) } : {}),
  createHarness: () => {
    const harness = createPiHarness({ scriptedSteps: effectiveSteps });
    return timingEnabled ? measuredHarness(harness) : harness;
  },
  createSandbox: (runId) => {
    const sandbox = createAppleContainerSandbox({ runId, labels: { "eval-run": runId, "eval-test": "paired" }, ...(cliPath === undefined ? {} : { cliPath }), commandTimeoutMs: 60_000, readyTimeoutMs: 60_000, supervisorMaxMs: 150_000 });
    return timingEnabled ? measuredSandbox(sandbox) : sandbox;
  },
  createValidatorRunner: (runId) => {
    const validator = createContainerValidatorRunner({ runId, labels: { "eval-run": runId, "eval-test": "paired" }, ...(cliPath === undefined ? {} : { cliPath }), commandTimeoutMs: 60_000 });
    return timingEnabled ? measuredValidator(validator) : validator;
  },
};
const outcome = await runCli([
  "--suite", suiteId,
  "--case", abortStage === "grading" ? "workspace/busy-validator" : fault === "grading" ? "workspace/bad-validator" : "workspace/paired-sdk",
  "--mode", "fake",
  "--harness", "pi",
  "--sandbox", "apple-container",
  "--validator-runner", "isolated-container",
  "--provider", "google",
  "--model", "gemini-3.8-flash",
  "--thinking", "low",
  "--scheduling", policy,
  "--repetitions", String(repetitions),
], composition);
if (outcome.receiptPath !== null) process.stdout.write(`PAIRED_RECEIPT=${outcome.receiptPath}\n`);
if (outcome.runDir !== null) process.stdout.write(`PAIRED_RUN_DIR=${outcome.runDir}\n`);
if (timingEnabled) {
  process.stdout.write(`PAIRED_METRICS=${JSON.stringify({ measurements, progress, childInvocationWindowMs: Date.now() - childInvocationStartedAtMs })}\n`);
}
if (fault !== undefined) process.exit(outcome.code);
if (outcome.code !== 0 || outcome.receiptPath === null || outcome.runDir === null) process.exit(outcome.code || 1);
const receipt = JSON.parse(readFileSync(outcome.receiptPath, "utf8")) as { pairs: Array<{ conditions: Array<{ conditionId: string; dir: string }> }> };
const viewsDir = join(outcome.runDir, "views");
await mkdir(viewsDir, { recursive: true });
const htmlPaths: string[] = [];
for (const condition of receipt.pairs[0]!.conditions) {
  const session = await readNativeSession(outcome.receiptPath, condition.dir);
  if (!session.available || session.header === null || session.incompleteTail) throw new Error(`${condition.conditionId} sanitized session is unavailable`);
  const jsonl = join(viewsDir, `${condition.conditionId}-session.jsonl`);
  const html = join(viewsDir, `${condition.conditionId}-session.html`);
  await writeFile(jsonl, session.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
  await exportSessionFileToHtml(jsonl, html);
  const checked = verifyExportedHtml(html, { disallowedSecrets: [secret] });
  if (!checked.valid) throw new Error(`unsafe ${condition.conditionId} HTML: ${checked.violations.join("; ")}`);
  htmlPaths.push(html);
}
if (!(await verifyRun(outcome.runDir)).ok) throw new Error("receipt changed while exporting derived HTML views");
process.stdout.write(`PAIRED_BASELINE_HTML=${htmlPaths[0]}\nPAIRED_TREATMENT_HTML=${htmlPaths[1]}\n`);
