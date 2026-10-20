/**
 * Fake sandbox conformance.
 *
 * The test double must honor the sandbox contract: no credential before attestation, no retained secret
 * value, cancellable staging and export, refused unsafe staged paths, and
 * exact-identity presence reporting for cleanup.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvalError, SAFE_DEFAULT_LIMITS } from "../core/types.ts";
import type { GuardedSecret } from "../core/secret-scan.ts";
import { FAKE_SANDBOX_ID, createFakeSandbox } from "./fake.ts";
import type { FakeSandbox, FakeSandboxFaults } from "./fake.ts";
import { defineSandboxConformance } from "./conformance.ts";
import type { Guest, GuestPolicy, GuestSpec, NetworkPolicy, Sandbox } from "./sandbox.ts";

/** The fixed non-root identity of the locked guest image, shared by both implementations. */
const conformancePolicy: GuestPolicy = {
  readOnlyRoot: true,
  writablePaths: ["/work", "/home/agent", "/tmp", "/run/eval"],
  uid: 10_001,
  gid: 10_001,
  noNewPrivileges: true,
  dropCapabilities: true,
};

const policy: GuestPolicy = {
  readOnlyRoot: true,
  writablePaths: ["/work"],
  uid: 1000,
  gid: 1000,
  noNewPrivileges: true,
  dropCapabilities: true,
};

const networkPolicy: NetworkPolicy = { allowPublicDns: true, allowPublicTcpPorts: [443], denyRanges: ["10.0.0.0/8"] };

/** Invented, never a real credential. */
const FAKE_SECRET: GuardedSecret = { label: "FAKE_TEST_KEY", value: "sk-test-NOTREAL-0123456789abcdef" };

interface Harnessed {
  readonly sandbox: Sandbox & { readonly live: { readonly guests: readonly string[]; readonly networks: readonly string[] } };
  readonly guest: Guest;
  readonly spec: GuestSpec;
}

async function makeGuest(
  options: { env?: Record<string, string>; guardedSecrets?: readonly GuardedSecret[] } = {},
): Promise<Harnessed> {
  const sandbox = createFakeSandbox(
    options.guardedSecrets === undefined ? {} : { guardedSecrets: options.guardedSecrets },
  );
  const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: "/ctx" });
  await sandbox.createNetwork("eval-net-1", networkPolicy);
  const spec: GuestSpec = {
    name: "eval-guest-1",
    networkName: "eval-net-1",
    imageDigest: image.digest,
    limits: SAFE_DEFAULT_LIMITS,
    policy,
    env: options.env ?? { HOME: "/home/eval" },
  };
  const guest = await sandbox.createGuest(spec);
  return { sandbox, guest, spec };
}

async function expectEvalErrorAsync(promise: Promise<unknown>, code: string): Promise<EvalError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EvalError);
  expect((caught as EvalError).code).toBe(code);
  return caught as EvalError;
}

describe("fake sandbox identity", () => {
  it("self-labels as a test double", async () => {
    const sandbox = createFakeSandbox();
    expect(sandbox.id).toBe(FAKE_SANDBOX_ID);
    expect(sandbox.testDouble).toBe(true);
    const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: "/ctx" });
    expect(image.testDouble).toBe(true);
    expect((await sandbox.probe()).ready).toBe(true);
  });

  it("produces the same digest for the same profile", async () => {
    const sandbox = createFakeSandbox();
    const first = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: "/a" });
    const second = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: "/b" });
    expect(second.digest).toBe(first.digest);
  });
});

describe("fake guest credential seam", () => {
  it("refuses deliverCredential before attest and accepts it after", async () => {
    const { guest } = await makeGuest();
    const error = await expectEvalErrorAsync(
      guest.deliverCredential({ variable: "GEMINI_API_KEY", value: FAKE_SECRET.value }),
      "secret-quarantine",
    );
    expect(error.message).toContain("attested");
    await guest.attest();
    await expect(
      guest.deliverCredential({ variable: "GEMINI_API_KEY", value: FAKE_SECRET.value }),
    ).resolves.toBeUndefined();
  });

  it("never retains the delivered value, only the variable name", async () => {
    const { guest } = await makeGuest();
    await guest.attest();
    await guest.deliverCredential({ variable: "GEMINI_API_KEY", value: FAKE_SECRET.value });
    const names = (guest as unknown as { deliveredCredentialVariables: readonly string[] })
      .deliveredCredentialVariables;
    expect(names).toEqual(["GEMINI_API_KEY"]);
    expect(JSON.stringify(names)).not.toContain(FAKE_SECRET.value);
    // The whole guest object must not have captured the value anywhere reachable.
    expect(JSON.stringify(guest, (_key, value: unknown) => value)).not.toContain(FAKE_SECRET.value);
  });

  it("rejects a non-allowlisted variable name and an empty value", async () => {
    const { guest } = await makeGuest();
    await guest.attest();
    await expectEvalErrorAsync(
      guest.deliverCredential({ variable: "gemini_api_key", value: FAKE_SECRET.value }),
      "secret-quarantine",
    );
    await expectEvalErrorAsync(
      guest.deliverCredential({ variable: "GEMINI_API_KEY", value: "" }),
      "credential-missing",
    );
  });

  it("refuses a credential-shaped variable in the guest specification", async () => {
    await expectEvalErrorAsync(makeGuest({ env: { GEMINI_API_KEY: "x" } }), "secret-quarantine");
  });

  it("refuses a guarded secret VALUE hidden in a benignly named variable", async () => {
    const error = await expectEvalErrorAsync(
      makeGuest({ env: { CONFIG_BLOB: `prefix ${FAKE_SECRET.value}` }, guardedSecrets: [FAKE_SECRET] }),
      "secret-quarantine",
    );
    expect(error.message).toContain("FAKE_TEST_KEY");
    expect(error.message).not.toContain(FAKE_SECRET.value);
  });
});

describe("fake guest staging and export", () => {
  it("stages files and exports them back", async () => {
    const { guest } = await makeGuest();
    await guest.stage({
      destDir: "/work",
      files: [
        { path: "config.json", base64: Buffer.from("{}").toString("base64"), mode: 0o644 },
        { path: "nested/notes.md", base64: Buffer.from("hi").toString("base64"), mode: 0o644 },
      ],
      readOnly: false,
    });
    const exported = await guest.exportFiles({
      root: "/work",
      maxFiles: 10,
      maxFileBytes: 1_000,
      maxTotalBytes: 10_000,
    });
    expect(exported.files.map((file) => file.path).sort()).toEqual(["config.json", "nested/notes.md"]);
    expect(exported.truncated).toBe(false);
  });

  it.each(["../escape.txt", "/abs.txt", "a//b.txt", "a\\b.txt", ".hidden"])(
    "rejects unsafe staged path %s",
    async (path) => {
      const { guest } = await makeGuest();
      await expectEvalErrorAsync(
        guest.stage({
          destDir: "/work",
          files: [{ path, base64: Buffer.from("x").toString("base64"), mode: 0o644 }],
          readOnly: false,
        }),
        "path-unsafe",
      );
    },
  );

  it("rejects an unsafe destination directory", async () => {
    const { guest } = await makeGuest();
    await expectEvalErrorAsync(
      guest.stage({ destDir: "/work/../../etc", files: [], readOnly: false }),
      "path-unsafe",
    );
  });

  it("honours an AbortSignal on stage", async () => {
    const { guest } = await makeGuest();
    const controller = new AbortController();
    controller.abort();
    await expectEvalErrorAsync(
      guest.stage({
        destDir: "/work",
        files: [{ path: "a.txt", base64: "", mode: 0o644 }],
        readOnly: false,
        signal: controller.signal,
      }),
      "interrupted",
    );
  });

  it("honours an AbortSignal on export", async () => {
    const { guest } = await makeGuest();
    const controller = new AbortController();
    controller.abort();
    await expectEvalErrorAsync(
      guest.exportFiles({
        root: "/work",
        maxFiles: 1,
        maxFileBytes: 1,
        maxTotalBytes: 1,
        signal: controller.signal,
      }),
      "interrupted",
    );
  });

  it("bounds export by file count and byte budget", async () => {
    const { guest } = await makeGuest();
    await guest.stage({
      destDir: "/work",
      files: [
        { path: "a.txt", base64: Buffer.from("a".repeat(20)).toString("base64"), mode: 0o644 },
        { path: "b.txt", base64: Buffer.from("b".repeat(20)).toString("base64"), mode: 0o644 },
      ],
      readOnly: false,
    });
    const byCount = await guest.exportFiles({ root: "/work", maxFiles: 1, maxFileBytes: 100, maxTotalBytes: 1_000 });
    expect(byCount.files).toHaveLength(1);
    expect(byCount.truncated).toBe(true);
    const byBytes = await guest.exportFiles({ root: "/work", maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 25 });
    expect(byBytes.files).toHaveLength(1);
    expect(byBytes.truncated).toBe(true);
  });

  it("never executes a command", async () => {
    const { guest } = await makeGuest();
    await expectEvalErrorAsync(
      guest.exec({ command: ["echo", "hi"], cwd: "/work", timeoutMs: 10, maxOutputBytes: 10 }),
      "not-implemented",
    );
  });
});

describe("fake sandbox lifecycle and cleanup", () => {
  it("reports exact-identity presence and absence", async () => {
    const { sandbox, spec } = await makeGuest();
    expect(await sandbox.inspectResource("guest", spec.name)).toBe("present");
    expect(await sandbox.inspectResource("guest", "eval-guest-other")).toBe("absent");
    expect(await sandbox.inspectResource("network", "eval-net-1")).toBe("present");
    expect(await sandbox.inspectResource("network", "eval-net-2")).toBe("absent");

    expect(await sandbox.destroyResource("guest", spec.name)).toMatchObject({ status: "destroyed", verified: true });
    expect(await sandbox.inspectResource("guest", spec.name)).toBe("absent");
    expect(await sandbox.destroyResource("guest", spec.name)).toMatchObject({ status: "already-absent" });
    expect(await sandbox.destroyResource("network", "eval-net-2")).toMatchObject({ status: "already-absent" });
  });

  it("refuses to reuse a live guest after destruction", async () => {
    const { guest } = await makeGuest();
    expect(await guest.destroy()).toMatchObject({ status: "destroyed" });
    await expectEvalErrorAsync(guest.attest(), "evidence-invalid");
  });

  it("refuses a guest without its network or image", async () => {
    const sandbox = createFakeSandbox();
    const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: "/ctx" });
    const base = { limits: SAFE_DEFAULT_LIMITS, policy, env: {} };
    await expectEvalErrorAsync(
      sandbox.createGuest({ ...base, name: "g", networkName: "absent", imageDigest: image.digest }),
      "evidence-invalid",
    );
    await sandbox.createNetwork("n", networkPolicy);
    await expectEvalErrorAsync(
      sandbox.createGuest({ ...base, name: "g", networkName: "n", imageDigest: "sha256:absent" }),
      "evidence-invalid",
    );
  });

  it("refuses duplicate exact identities", async () => {
    const { sandbox, spec } = await makeGuest();
    await expectEvalErrorAsync(sandbox.createGuest(spec), "evidence-invalid");
    await expectEvalErrorAsync(sandbox.createNetwork("eval-net-1", networkPolicy), "evidence-invalid");
  });

  it("attests the configured guest policy", async () => {
    const { guest } = await makeGuest();
    const attestation = await guest.attest();
    expect(attestation).toMatchObject({
      uid: policy.uid,
      noNewPrivileges: true,
      capabilitiesDropped: true,
      readOnlyRoot: true,
      hostMounts: [],
    });
    expect(attestation.egress.resolverInherited).toBe(false);
  });
});

describe("deterministic cleanup-failure injection", () => {
  /** Cleanup failure is a contract branch, so the double must be able to produce it. */
  async function faulted(faults: FakeSandboxFaults | undefined): Promise<FakeSandbox> {
    const sandbox = createFakeSandbox(faults === undefined ? {} : { faults });
    const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: "/ctx" });
    await sandbox.createNetwork("eval-net-1", networkPolicy);
    await sandbox.createGuest({
      name: "eval-guest-1",
      networkName: "eval-net-1",
      imageDigest: image.digest,
      limits: SAFE_DEFAULT_LIMITS,
      policy,
      env: { HOME: "/home/eval" },
    });
    return sandbox;
  }

  it("never fails by default", async () => {
    const sandbox = await faulted(undefined);
    expect(await sandbox.destroyResource("guest", "eval-guest-1")).toMatchObject({ status: "destroyed" });
    expect(await sandbox.inspectResource("guest", "eval-guest-1")).toBe("absent");
  });

  it("fails a named destroy and leaves the resource present", async () => {
    const sandbox = await faulted({ destroyFails: ["guest:eval-guest-1"] });
    const outcome = await sandbox.destroyResource("guest", "eval-guest-1");
    expect(outcome.status).toBe("failed");
    expect(outcome.verified).toBe(false);
    expect(outcome.failure?.code).toBe("cleanup-failed");
    expect(await sandbox.inspectResource("guest", "eval-guest-1")).toBe("present");
  });

  it("reports a successful destroy while leaving the resource present", async () => {
    const sandbox = await faulted({ destroyLeavesPresent: ["guest:eval-guest-1"] });
    expect(await sandbox.destroyResource("guest", "eval-guest-1")).toMatchObject({ status: "destroyed" });
    // The return value lied; only an exact-identity re-inspection can catch it.
    expect(await sandbox.inspectResource("guest", "eval-guest-1")).toBe("present");
  });

  it("lets a verified-absent resource reappear exactly once afterwards", async () => {
    const sandbox = await faulted({ reappearsAfterDestroy: ["network:eval-net-1"] });
    expect(await sandbox.destroyResource("network", "eval-net-1")).toMatchObject({ status: "destroyed" });
    expect(await sandbox.inspectResource("network", "eval-net-1")).toBe("absent");
    expect(await sandbox.inspectResource("network", "eval-net-1")).toBe("present");
  });

  it("matches exact identities only, never a prefix or a pattern", async () => {
    const sandbox = await faulted({ destroyFails: ["guest:eval-guest-99"] });
    expect(await sandbox.destroyResource("guest", "eval-guest-1")).toMatchObject({ status: "destroyed" });
  });
});

/**
 * The double must satisfy exactly the same behavioural suite as the real Apple Container
 * sandbox (evals/src/sandboxes/apple-container.test.ts). If it ever stops doing so, it
 * has stopped standing in for anything.
 */
defineSandboxConformance({
  name: "fake",
  testDouble: true,
  create: async () => ({
    sandbox: createFakeSandbox(),
    contextDir: "/ctx",
    policy: conformancePolicy,
    namePrefix: `eval-conf-fake-${randomBytes(3).toString("hex")}`,
  }),
});
