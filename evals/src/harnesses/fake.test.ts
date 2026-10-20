/**
 * @notice Verifies deterministic fake harness outcomes, parity metadata, and skill isolation.
 */

import { describe, expect, it } from "vitest";
import { EMPTY_SKILL_TOOL_BUNDLE } from "../core/skill-tools.ts";
import { EvalError, SAFE_DEFAULT_LIMITS } from "../core/types.ts";
import { canonicalJsonSha256 } from "../core/experiment.ts";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import type { Guest } from "../sandboxes/sandbox.ts";
import { FAKE_HARNESS_ID, createFakeHarness, noopFakeScript } from "./fake.ts";
import type { HarnessRequest } from "./harness.ts";

async function makeGuest(): Promise<Guest> {
  const sandbox = createFakeSandbox();
  const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: "/ctx" });
  await sandbox.createNetwork("net", { allowPublicDns: true, allowPublicTcpPorts: [443], denyRanges: [] });
  const guest = await sandbox.createGuest({
    name: "guest",
    networkName: "net",
    imageDigest: image.digest,
    limits: SAFE_DEFAULT_LIMITS,
    policy: {
      readOnlyRoot: true,
      writablePaths: ["/work"],
      uid: 1000,
      gid: 1000,
      noNewPrivileges: true,
      dropCapabilities: true,
    },
    env: {},
  });
  await guest.stage({
    destDir: "/work",
    files: [{ path: "config.json", base64: Buffer.from('{"a":1}').toString("base64"), mode: 0o644 }],
    readOnly: false,
  });
  return guest;
}

function request(overrides: Partial<HarnessRequest> = {}): HarnessRequest {
  return {
    conditionId: "baseline",
    prompt: "migrate the config",
    workspaceRoot: "/work",
    skillPaths: [],
    allowedTools: ["read", "write"],
    skillToolBundle: null,
    skillToolBundleSha256: canonicalJsonSha256(EMPTY_SKILL_TOOL_BUNDLE),
    limits: SAFE_DEFAULT_LIMITS,
    target: { provider: "google", model: "fake-model", thinking: "off" },
    ...overrides,
  };
}

describe("fake harness", () => {
  it("self-labels as a test double", async () => {
    const harness = createFakeHarness();
    expect(harness.id).toBe(FAKE_HARNESS_ID);
    expect(harness.testDouble).toBe(true);
    expect((await harness.probe()).ready).toBe(true);
  });

  it("produces a baseline run with zero skill paths", async () => {
    const guest = await makeGuest();
    const result = await createFakeHarness().run(guest, request());
    expect(result.runtime.skillPaths).toEqual([]);
    expect(result.runtime.testDouble).toBe(true);
    expect(result.runtime.ambientDiscoveryDisabled).toBe(true);
    expect(result.runtime.implicitRetryDisabled).toBe(true);
    expect(result.outcome).toBe("completed");
    expect(result.usage.providerRequests).toBe(0);
  });

  it("produces a treatment run with exactly one skill path", async () => {
    const guest = await makeGuest();
    const result = await createFakeHarness().run(
      guest,
      request({ conditionId: "treatment", skillPaths: ["/opt/skills/arbitrum-docs"] }),
    );
    expect(result.runtime.skillPaths).toEqual(["/opt/skills/arbitrum-docs"]);
  });

  it("attests the runtime identity before dispatch", async () => {
    const guest = await makeGuest();
    const attestation = await createFakeHarness().attest(guest, request());
    expect(attestation.runtime.harnessId).toBe(FAKE_HARNESS_ID);
    expect(attestation.runtime.provider).toBe("google");
    expect(attestation.runtime.model).toBe("fake-model");
  });

  it("changes nothing under the default script", async () => {
    const guest = await makeGuest();
    const before = await guest.exportFiles({ root: "/work", maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 10_000 });
    await createFakeHarness({ script: noopFakeScript }).run(guest, request());
    const after = await guest.exportFiles({ root: "/work", maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 10_000 });
    expect(after.files).toEqual(before.files);
  });

  it("applies an injected script's workspace writes and sees the prior workspace", async () => {
    const guest = await makeGuest();
    let observed: readonly string[] = [];
    const result = await createFakeHarness({
      script: (_req, workspace) => {
        observed = workspace.map((file) => file.path);
        return {
          outcome: "completed",
          writes: [{ path: "config.json", text: '{"a":2}' }],
          assistantText: "done",
          providerRequests: 1,
        };
      },
    }).run(guest, request());
    expect(observed).toEqual(["config.json"]);
    expect(result.usage.providerRequests).toBe(1);
    const after = await guest.exportFiles({ root: "/work", maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 10_000 });
    expect(Buffer.from(after.files[0]?.base64 ?? "", "base64").toString("utf8")).toBe('{"a":2}');
  });

  it("classifies a task limit and an infrastructure failure distinctly", async () => {
    const guest = await makeGuest();
    const limited = await createFakeHarness({ script: () => ({ outcome: "task-limit" }) }).run(guest, request());
    expect(limited.outcome).toBe("task-limit");
    const broken = await createFakeHarness({
      script: () => ({
        outcome: "infrastructure-failure",
        failures: [{ code: "protocol-drift", failureClass: "infrastructure", message: "m", at: null }],
      }),
    }).run(guest, request());
    expect(broken.outcome).toBe("infrastructure-failure");
    expect(broken.failures).toHaveLength(1);
  });

  it("truncates an over-long prompt into bounded evidence", async () => {
    const guest = await makeGuest();
    const result = await createFakeHarness().run(guest, request({ prompt: "p".repeat(5_000) }));
    expect(result.messages[0]?.truncated).toBe(true);
    expect(result.messages[0]?.text.length).toBe(4_000);
  });

  it("honours an AbortSignal on attest and run", async () => {
    const guest = await makeGuest();
    const controller = new AbortController();
    controller.abort();
    const harness = createFakeHarness();
    await expect(harness.attest(guest, request({ signal: controller.signal }))).rejects.toBeInstanceOf(EvalError);
    await expect(harness.run(guest, request({ signal: controller.signal }))).rejects.toBeInstanceOf(EvalError);
  });
});
