/** Disposable host worker for owner-authored fake-mode grading. */
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { decodeValidationOutcome, EvalError, toStructuredFailure } from "../core/types.ts";
import type { CaseValidatorModule, SnapshotValidationInput } from "../core/types.ts";
import { installCompletionTransportBlocker } from "../transport-blocker.ts";

if (parentPort === null) throw new Error("validator worker requires a parent port");
const input = workerData as { validatorPath: string; input: SnapshotValidationInput };
installCompletionTransportBlocker();

// Keep unresolved top-level awaits alive until the parent's bounded deadline fires.
const keepAlive = setInterval(() => undefined, 60_000);
try {
  const loaded = await import(pathToFileURL(input.validatorPath).href) as Partial<CaseValidatorModule>;
  if (typeof loaded.validateSnapshot !== "function") {
    throw new EvalError("validator-infrastructure", `validator ${input.validatorPath} does not export validateSnapshot()`);
  }
  const outcome = decodeValidationOutcome(loaded.validateSnapshot(input.input), "validator outcome");
  parentPort.postMessage({ outcome });
} catch (error) {
  parentPort.postMessage({ failure: toStructuredFailure(error, "validator-infrastructure") });
} finally {
  clearInterval(keepAlive);
  parentPort.close();
}
