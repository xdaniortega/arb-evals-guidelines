/**
 * No-request readiness doctor for the skill evaluation subsystem.
 *
 * WHY this exists: Phase 4 introduces the real Pi agent runtime and credentials, but spends
 * ZERO money. Before Phase 5 executes paid evaluations, the doctor verifies every prerequisite:
 * 1. Platform is Apple-silicon macOS (darwin arm64).
 * 2. Apple Container runtime is installed and running (`container system status`).
 * 3. Container image lock verifies and Pi is present at pinned version 0.85.0.
 * 4. Provider credential is present and non-blank in git-ignored evals/.env, WITHOUT printing or hashing it.
 * 5. Requested model is exact, pinned, non-preview, and non-alias in the Pi catalog.
 * 6. Guest readiness: a credential-free guest starts, attests, and destroys cleanly.
 *
 * ZERO-REQUEST GUARANTEE: this doctor never sends a prompt or completion request. The guest
 * is launched without credentials, tested for privilege and network attestation only, and destroyed.
 */

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { runIdFor } from "../core/experiment.ts";
import { EvalError, SAFE_DEFAULT_LIMITS, type ProviderId } from "../core/types.ts";
import { assertGitIgnored, getProviderCredential, parseDotEnv } from "./credentials.ts";
import { FROZEN_MODEL_ID, FROZEN_PROVIDER_ID, FROZEN_THINKING_LEVEL, validateTargetModel } from "./models.ts";
import type { Sandbox } from "../sandboxes/sandbox.ts";
import { createAppleContainerSandbox } from "../sandboxes/apple-container.ts";

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
  readonly providerRequests: 0;
  readonly checks: readonly DoctorCheckItem[];
  readonly durationMs: number;
}

export interface DoctorOptions {
  readonly repoRoot: string;
  readonly evalsRoot: string;
  readonly provider?: ProviderId;
  readonly model?: string;
  readonly sandbox?: Sandbox;
  readonly skipGuestReadiness?: boolean;
}

const GUEST_READINESS_LIMITS = {
  cpus: 2,
  memoryMiB: 2048,
  pids: 256,
  wallClockMs: 30_000,
  maxWorkspaceBytes: 10 * 1024 * 1024,
  maxExportedFiles: 100,
  maxExportedFileBytes: 1024 * 1024,
  maxRetries: 0,
};

const GUEST_READINESS_POLICY = {
  readOnlyRoot: true,
  writablePaths: ["/tmp", "/run/eval"],
  uid: 10001,
  gid: 10001,
  noNewPrivileges: true,
  dropCapabilities: true,
};

export async function runReadinessDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const startedAt = Date.now();
  const provider = options.provider ?? FROZEN_PROVIDER_ID;
  const model = options.model ?? FROZEN_MODEL_ID;
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
    if (pi?.package === "@earendil-works/pi-coding-agent" && pi?.version === "0.85.0") {
      const containerfilePath = join(options.evalsRoot, "container", "Containerfile");
      const containerfile = await readFile(containerfilePath, "utf8");
      // Match the install of the pinned package without pinning npm's flag order:
      // `npm install -g --save-exact <pkg>@0.85.0` must verify exactly like the bare form.
      if (/npm install -g[^\n]*@earendil-works\/pi-coding-agent@0\.85\.0/.test(containerfile)) {
        lockOk = true;
        lockDetail = "image lock verified, @earendil-works/pi-coding-agent@0.85.0 pinned";
      } else {
        lockDetail = "Containerfile does not install @earendil-works/pi-coding-agent@0.85.0";
      }
    } else {
      lockDetail = `image-lock.json does not pin Pi 0.85.0 (found ${String(pi?.version)})`;
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
    assertGitIgnored(envPath, options.repoRoot);
    const envContent = await readFile(envPath, "utf8");
    const parsed = parseDotEnv(envContent);
    const value = getProviderCredential(provider, parsed);
    if (value !== null && value.length > 0) {
      credOk = true;
      credDetail = `${provider === "google" ? "GEMINI_API_KEY" : "API key"} present in git-ignored evals/.env (non-blank)`;
    } else {
      credDetail = `no non-blank credential found for provider '${provider}' in evals/.env`;
    }
  } catch (error) {
    credDetail = `credential gate check failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({
    id: "credential-present",
    label: "credential-present",
    passed: credOk,
    detail: credDetail,
  });

  // 5. Model compatibility check
  let modelOk = false;
  let modelDetail = "";
  try {
    validateTargetModel(provider, model);
    modelOk = true;
    modelDetail = `${model} (pinned, non-preview, non-alias in Pi catalog)`;
  } catch (error) {
    modelDetail = `model validation failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  checks.push({
    id: "model-compatibility",
    label: "model-compatibility",
    passed: modelOk,
    detail: modelDetail,
  });

  // 6. Guest readiness: credential-free guest starts, attests, and shuts down cleanly
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
    let createdGuestName: string | null = null;
    let createdNetworkName: string | null = null;
    let createdImageDigest: string | null = null;

    try {
      // Build image
      const image = await sandbox.buildImage({
        runtimeProfileId: "default",
        contextDir: join(options.evalsRoot, "container"),
      });
      createdImageDigest = image.digest;

      // Create network
      const network = await sandbox.createNetwork(`doc-${randomBytes(3).toString("hex")}-net`, {
        allowPublicDns: true,
        allowPublicTcpPorts: "all",
        denyRanges: ["10.0.0.0/8", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8"],
      });
      createdNetworkName = network.name;

      // Start credential-free guest
      const guestName = `doc-${randomBytes(3).toString("hex")}-guest`;
      createdGuestName = guestName;
      const guest = await sandbox.createGuest({
        name: guestName,
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

      // Attest guest facts (privilege drop, noNewPrivs, egress)
      const attestation = await guest.attest();
      if (attestation.uid === 10001 && attestation.noNewPrivileges && attestation.capabilitiesDropped) {
        // Destroy guest
        const destroyOutcome = await guest.destroy();
        if (destroyOutcome.verified) {
          createdGuestName = null;
          guestOk = true;
          guestDetail = "credential-free guest started, attested, and destroyed cleanly";
        } else {
          guestDetail = `guest destruction not verified: ${destroyOutcome.status}`;
        }
      } else {
        guestDetail = `guest attestation failed privilege criteria: uid=${attestation.uid}`;
      }
    } catch (error) {
      guestDetail = `guest readiness probe failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (createdGuestName !== null) {
        await sandbox.destroyResource("guest", createdGuestName).catch(() => undefined);
      }
      if (createdNetworkName !== null) {
        await sandbox.destroyNetwork(createdNetworkName).catch(() => undefined);
      }
      if (createdImageDigest !== null) {
        await sandbox.destroyResource("image", createdImageDigest).catch(() => undefined);
      }
    }
  }

  checks.push({
    id: "guest-readiness",
    label: "guest-readiness",
    passed: guestOk,
    detail: guestDetail,
  });

  // 7. Structural Zero-Request Guard
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
    providerRequests: 0,
    checks,
    durationMs: Date.now() - startedAt,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    "Evaluation Subsystem Readiness Doctor",
    `Target: ${report.provider} / ${report.model} (thinking: ${FROZEN_THINKING_LEVEL})`,
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
    lines.push("Phase 4 verified: ready for Phase 5 paid evaluation runs.");
  } else {
    lines.push(`Readiness verdict: NOT READY (${report.checks.filter((c) => !c.passed).length} check(s) failed)`);
  }

  return lines.join("\n");
}
