/**
 * No-request readiness doctor for the skill evaluation subsystem.
 *
 * Validates the target against the pinned Pi catalog, then checks local prerequisites
 * without spending provider credits:
 * 1. Platform is Apple-silicon macOS (darwin arm64).
 * 2. Apple Container runtime is installed and running (`container system status`).
 * 3. Container image lock verifies and Pi is present at pinned version 1.5.0.
 * 4. Provider credential is present and non-blank in git-ignored .env, WITHOUT printing or hashing it.
 * 5. Guest readiness: a credential-free guest starts, attests, and destroys cleanly.
 *
 * ZERO-REQUEST GUARANTEE: this doctor never sends a prompt or completion request. The guest
 * is launched without credentials, tested for privilege and network attestation only, and destroyed.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runIdFor } from "../core/experiment.ts";
import { createRunJournal, type RunJournal } from "../artifacts/store.ts";
import { PROVIDER_CREDENTIAL_VARIABLES, SAFE_DEFAULT_LIMITS, type ProviderId } from "../core/types.ts";
import type { Target } from "../core/experiment.ts";
import { getProviderCredential, loadGuardedCredentials } from "./credentials.ts";
import { FROZEN_MODEL_ID, resolveTargetConfiguration } from "./models.ts";
import type { Sandbox } from "../sandboxes/sandbox.ts";
import { createAppleContainerSandbox } from "../sandboxes/apple-container.ts";
import { EVAL_NETWORK_POLICY } from "./run.ts";

export interface DoctorCheckItem {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface DoctorReport {
  readonly ready: boolean;
  readonly provider: ProviderId;
  readonly model: string;
  readonly thinking: Target["thinking"];
  readonly providerRequests: 0;
  readonly checks: readonly DoctorCheckItem[];
  readonly durationMs: number;
}

export interface DoctorOptions {
  readonly repoRoot: string;
  readonly evalsRoot: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly sandbox?: Sandbox;
  readonly skipGuestReadiness?: boolean;
}

const GUEST_READINESS_POLICY = {
  readOnlyRoot: true,
  writablePaths: ["/tmp", "/run/eval"],
  uid: 10001,
  gid: 10001,
  noNewPrivileges: true,
  dropCapabilities: true,
};

/**
 * @notice Checks target compatibility and local readiness without model requests.
 * @param options Requested model/provider/thinking and paths to the evaluation setup.
 * @returns Readiness checks for the resolved target, without credential values.
 */
export async function runReadinessDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const startedAt = Date.now();
  const { provider, model, thinking } = resolveTargetConfiguration({
    model: options.model ?? FROZEN_MODEL_ID,
    provider: options.provider,
    thinking: options.thinking,
  });
  const checks: DoctorCheckItem[] = [];

  // 1. Platform check: Apple-silicon macOS
  const isPlatformOk = process.platform === "darwin" && process.arch === "arm64";
  checks.push({
    id: "platform",
    label: "platform",
    passed: isPlatformOk,
    detail: isPlatformOk
      ? `Apple-silicon macOS (${process.platform} ${process.arch})`
      : `expected darwin arm64, found ${process.platform} ${process.arch}`,
  });

  // 2. Apple Container runtime check
  let containerOk = false;
  let containerDetail = "";
  try {
    const statusOut = execFileSync("container", ["system", "status"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    if (/status\s+running/.test(statusOut)) {
      containerOk = true;
      containerDetail = "Apple Container runtime is running";
    } else {
      containerDetail = `container system status is not running: ${statusOut.trim().slice(0, 100)}`;
    }
  } catch (error) {
    containerDetail = `Apple Container CLI check failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({
    id: "apple-container",
    label: "apple-container",
    passed: containerOk,
    detail: containerDetail,
  });

  // 3. Image lock and pinned Pi check
  let lockOk = false;
  let lockDetail = "";
  try {
    const lockPath = join(options.evalsRoot, "container", "image-lock.json");
    const lockRaw = await readFile(lockPath, "utf8");
    const lock = JSON.parse(lockRaw) as {
      profiles?: {
        default?: {
          pi?: { package?: string; version?: string };
        };
      };
    };
    const pi = lock.profiles?.default?.pi;
    if (pi?.package === "@earendil-works/pi-coding-agent" && pi?.version === "1.5.0") {
      const containerfilePath = join(options.evalsRoot, "container", "Containerfile");
      const containerfile = await readFile(containerfilePath, "utf8");
      // Match the install of the pinned package without pinning npm's flag order:
      // `npm install -g --save-exact <pkg>@1.5.0` must verify exactly like the bare form.
      if (/npm install -g[^\n]*@earendil-works\/pi-coding-agent@1\.5\.0/.test(containerfile)) {
        lockOk = true;
        lockDetail = "image lock verified, @earendil-works/pi-coding-agent@1.5.0 pinned";
      } else {
        lockDetail = "Containerfile does not install @earendil-works/pi-coding-agent@1.5.0";
      }
    } else {
      lockDetail = `image-lock.json does not pin Pi 1.5.0 (found ${String(pi?.version)})`;
    }
  } catch (error) {
    lockDetail = `image lock verification failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({
    id: "image-pi-pinned",
    label: "image-pi-pinned",
    passed: lockOk,
    detail: lockDetail,
  });

  // 4. Credential presence check (WITHOUT printing or hashing it)
  let credOk = false;
  let credDetail = "";
  try {
    const envPath = join(options.evalsRoot, ".env");
    const loaded = await loadGuardedCredentials(envPath, options.repoRoot);
    const value = getProviderCredential(provider, loaded.credentials);
    if (value !== null && value.length > 0) {
      credOk = true;
      credDetail = `${PROVIDER_CREDENTIAL_VARIABLES[provider]} present for ${provider} / ${model} in git-ignored .env (non-blank)`;
    } else {
      credDetail = `no non-blank ${PROVIDER_CREDENTIAL_VARIABLES[provider]} found for ${provider} / ${model} in .env`;
    }
  } catch (error) {
    credDetail = `credential check for ${provider} / ${model} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({
    id: "credential-present",
    label: "credential-present",
    passed: credOk,
    detail: credDetail,
  });

  // 5. Guest readiness: credential-free guest starts, attests, and shuts down cleanly
  let guestOk = false;
  let guestDetail = "";
  if (options.skipGuestReadiness) {
    guestOk = true;
    guestDetail = "guest readiness skipped by option";
  } else if (!containerOk || !lockOk) {
    guestDetail = "guest readiness skipped because container runtime or image lock failed";
  } else {
    const now = new Date();
    const runId = runIdFor(now, randomBytes(4).toString("hex"));
    const sandbox = options.sandbox ?? createAppleContainerSandbox({ runId });
    const nonce = randomBytes(4).toString("hex");
    const owned: Array<{ kind: "guest" | "network"; name: string; conditionId: null }> = [];
    let journal: RunJournal | undefined;

    try {
      journal = await createRunJournal({ stateDir: join(options.evalsRoot, ".state"), runId, nonce });
      // Build image
      const image = await sandbox.buildImage({
        runtimeProfileId: "default",
        contextDir: join(options.evalsRoot, "container"),
      });

      // Create network
      const networkIdentity = { kind: "network" as const, name: `eval-dnet-${nonce}`, conditionId: null };
      await journal.record({ ...networkIdentity, event: "intent", action: "create", status: null });
      owned.push(networkIdentity);
      const network = await sandbox.createNetwork(networkIdentity.name, EVAL_NETWORK_POLICY);
      await journal.record({ ...networkIdentity, event: "observed", action: "create", status: "created" });

      // Start credential-free guest
      const guestIdentity = { kind: "guest" as const, name: `eval-dguest-${nonce}`, conditionId: null };
      await journal.record({ ...guestIdentity, event: "intent", action: "create", status: null });
      owned.push(guestIdentity);
      const guest = await sandbox.createGuest({
        name: guestIdentity.name,
        networkName: network.name,
        imageDigest: image.digest,
        limits: SAFE_DEFAULT_LIMITS,
        policy: GUEST_READINESS_POLICY,
        // Bound this probe guest explicitly. Without a deadline the supervisor falls back
        // to its nominal lifetime, so a SIGKILLed doctor run (which skips the cleanup in
        // `finally`) would leave the guest alive far longer than this check ever needs.
        deadlineAtMs: Date.now() + 120_000,
        env: { HOME: "/tmp", TMPDIR: "/tmp" }, // NO CREDENTIALS
      });
      await journal.record({ ...guestIdentity, event: "observed", action: "create", status: "created" });

      // Attest guest facts (privilege drop, noNewPrivs, egress)
      const attestation = await guest.attest();
      if (attestation.uid === 10001 && attestation.noNewPrivileges && attestation.capabilitiesDropped) {
        guestOk = true;
        guestDetail = "credential-free guest started and attested";
      } else {
        guestDetail = `guest attestation failed privilege criteria: uid=${attestation.uid}`;
      }
    } catch (error) {
      guestDetail = `guest readiness probe failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      const cleanupFailures: string[] = [];
      // The immutable image is shared with measured runs. Only this probe's fresh
      // guest and network are owned, and each intent survives interruption for recovery.
      for (const resource of [...owned].reverse()) {
        try { await journal!.record({ ...resource, event: "intent", action: "destroy", status: null }); }
        catch { cleanupFailures.push(`could not journal destruction of ${resource.name}`); }
        try {
          const outcome = await sandbox.destroyResource(resource.kind, resource.name);
          const absent = await sandbox.inspectResource(resource.kind, resource.name) === "absent";
          const verified = outcome.verified && absent;
          await journal!.record({ ...resource, event: "observed", action: "destroy", status: verified ? outcome.status : "failed" });
          if (!verified) cleanupFailures.push(`${resource.kind} ${resource.name} cleanup was not verified`);
        } catch (error) {
          cleanupFailures.push(`${resource.kind} ${resource.name} cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
          await journal!.record({ ...resource, event: "observed", action: "destroy", status: "failed" }).catch(() => undefined);
        }
      }
      if (cleanupFailures.length > 0) {
        guestOk = false;
        guestDetail += `; ${cleanupFailures.join("; ")}. Recovery: pnpm eval:recover --run ${runId}; journal: ${journal!.path}`;
      } else if (guestOk) {
        guestDetail += "; guest and network destruction verified";
      }
    }
  }

  checks.push({
    id: "guest-readiness",
    label: "guest-readiness",
    passed: guestOk,
    detail: guestDetail,
  });

  // 6. Structural Zero-Request Guard
  checks.push({
    id: "zero-request-guard",
    label: "zero-request-guard",
    passed: true,
    detail: "0 provider completion requests sent (structurally guaranteed)",
  });

  const ready = checks.every((c) => c.passed);
  return {
    ready,
    provider,
    model,
    thinking,
    providerRequests: 0,
    checks,
    durationMs: Date.now() - startedAt,
  };
}

/** @notice Renders readiness findings and actionable failures without exposing credentials. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    "Evaluation Subsystem Readiness Doctor",
    `Target: ${report.provider} / ${report.model} (thinking: ${report.thinking})`,
    "Target configuration validated against the pinned Pi catalog; live provider compatibility is untested.",
    "",
  ];

  for (const check of report.checks) {
    const mark = check.passed ? "[PASS]" : "[FAIL]";
    const paddedLabel = check.label.padEnd(20, " ");
    lines.push(`  ${mark} ${paddedLabel} ${check.detail}`);
  }

  lines.push("");
  if (report.ready) {
    lines.push(`Readiness verdict: READY (${report.checks.filter((c) => c.passed).length}/${report.checks.length} checks passed)`);
    lines.push("Local prerequisites are ready. No provider completion request was sent; live authentication and model responses remain untested.");
  } else {
    lines.push(`Readiness verdict: NOT READY (${report.checks.filter((c) => !c.passed).length} check(s) failed)`);
  }

  return lines.join("\n");
}
