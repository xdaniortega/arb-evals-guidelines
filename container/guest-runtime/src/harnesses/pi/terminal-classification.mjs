import { deriveStopCause, } from "../../core/types.mjs";
/**
 * Cancellation messages emitted by a provider or the SDK when an abort we requested
 * lands. Anchored at both ends so a decorated failure such as
 * "This operation was aborted: upstream failure" is NOT treated as a clean cancellation.
 */
const KNOWN_ABORT_MESSAGE = /^(?:abort(?:error)?: )?(?:this )?(?:operation|request|sdk prompt)(?: was)? aborted\.?$/i;
function isExpectedAbortError(error) {
    if (error instanceof Error && error.name === "AbortError")
        return true;
    if (error &&
        typeof error === "object" &&
        "name" in error &&
        error.name === "EvalError" &&
        "code" in error &&
        error.code === "interrupted") {
        return true;
    }
    return false;
}
/**
 * Map a terminal classification to its infrastructure failure code.
 * Unexpected aborts map to protocol-drift, interrupted maps to interrupted,
 * and execution failures map to provider-error (unless the message explicitly
 * names protocol-drift). Completed and task-limit return null.
 */
export function failureCodeForTerminalClass(terminalClass, errorText) {
    switch (terminalClass) {
        case "interrupted":
            return "interrupted";
        case "unexpected-abort":
            return "protocol-drift";
        case "execution-failure":
            if (errorText && (errorText.includes("protocol-drift") || errorText.includes("drift_event"))) {
                return "protocol-drift";
            }
            return "provider-error";
        default:
            return null;
    }
}
/**
 * Pure terminal classification helper shared across local and guest harnesses.
 * Evaluates provider signals, harness abort state, and budget limits into a unified
 * terminal classification, harness outcome, precise stop cause, and failure code.
 */
export function classifyTerminalState(input) {
    const nativeStopReason = typeof input.stopReason === "string" ? input.stopReason : null;
    const rawStopReason = typeof input.rawStopReason === "string" ? input.rawStopReason : null;
    const executionError = input.executionError ?? null;
    const expectedAbortError = isExpectedAbortError(executionError);
    const nativeErrorMessage = typeof input.errorMessage === "string" ? input.errorMessage : null;
    const semanticAbortCause = input.semanticAbortCause ?? null;
    const taskLimitReason = typeof input.taskLimitReason === "string" ? input.taskLimitReason : null;
    const isLength = nativeStopReason === "length";
    const knownAbortMessage = nativeErrorMessage !== null && KNOWN_ABORT_MESSAGE.test(nativeErrorMessage.trim());
    // Some providers report a cancellation we requested as a plain error rather than an
    // abort. Normalize it only when THIS harness initiated the abort, so an unsolicited
    // provider-side abort error still classifies as a genuine failure.
    const stopReason = nativeStopReason === "error" && semanticAbortCause !== null && knownAbortMessage
        ? "aborted"
        : (nativeStopReason ?? (isLength ? "length" : null));
    const aborted = stopReason === "aborted";
    // A budget-terminal message is the harness's own doing, not an arbitrary failure.
    const nativeArbitraryFailure = aborted && nativeErrorMessage !== null && !knownAbortMessage && taskLimitReason === null;
    const arbitraryExecutionFailure = nativeArbitraryFailure || (executionError !== null && !(semanticAbortCause !== null && expectedAbortError));
    const terminalClass = arbitraryExecutionFailure || stopReason === "error"
        ? "execution-failure"
        : semanticAbortCause === "external"
            ? "interrupted"
            : semanticAbortCause === "arm-budget" || taskLimitReason !== null || isLength
                ? "task-limit"
                : aborted
                    ? "unexpected-abort"
                    : "completed";
    const outcome = terminalClass === "completed"
        ? "completed"
        : terminalClass === "task-limit"
            ? "task-limit"
            : "infrastructure-failure";
    const stopCause = deriveStopCause({
        terminalClass,
        semanticAbortCause,
        taskLimitReason,
        stopReason,
    });
    const failureErrorText = nativeErrorMessage ?? (executionError instanceof Error
        ? `${executionError.name}: ${executionError.message}`
        : executionError !== null && executionError !== undefined
            ? String(executionError)
            : null);
    let failureCode = null;
    if (outcome === "infrastructure-failure") {
        failureCode = failureCodeForTerminalClass(terminalClass, failureErrorText);
    }
    const providerStopReason = rawStopReason ?? (typeof stopReason === "string" ? stopReason : null);
    return {
        terminalClass,
        outcome,
        stopCause,
        failureCode,
        normalizedStopReason: stopReason,
        providerStopReason,
    };
}
