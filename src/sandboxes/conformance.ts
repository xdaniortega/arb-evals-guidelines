/**
 * The shared sandbox conformance suite.
 *
 * The contract requires that EVERY implementation of `Sandbox`/`Guest` satisfies the
 * same tests without changing experiment semantics. Two separate test files asserting
 * "roughly the same thing" would not be that: the double and the real implementation
 * would drift, and the double would stop standing in for anything. So the behavioural
 * expectations live here once and are executed against both implementations.
 *
 * It deliberately does NOT assert implementation detail (how a digest is computed, what
 * a guest is made of). It asserts the seams the runner depends on:
 * exact-identity lookup, benign already-absent destruction, staging and bounded export,
 * cooperative cancellation, and the credential-after-attestation gate.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvalError, SAFE_DEFAULT_LIMITS } from "../core/types.ts";
import type { Limits } from "../core/types.ts";
import type { Guest, GuestPolicy, Sandbox } from "./sandbox.ts";

/** Invented, never a real credential. */
export const CONFORMANCE_FAKE_SECRET = "sk-test-NOTREAL-0123456789abcdef";

export interface ConformanceTarget {
  readonly sandbox: Sandbox;
  /** Allowlisted build context this implementation builds from. */
  readonly contextDir: string;
  readonly policy: GuestPolicy;
  readonly limits?: Limits;
  /** Unique per invocation, so two implementations never collide on a host. */
  readonly namePrefix: string;
  dispose?(): Promise<void>;
}

async function expectEvalError(promise: Promise<unknown>, code: string): Promise<EvalError> {
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

export interface ConformanceOptions {
  readonly name: string;
  readonly testDouble: boolean;
  /** Per-test timeout; a real container needs far longer than an in-process double. */
  readonly timeoutMs?: number;
  create(): Promise<ConformanceTarget>;
}

/**
 * Registers the shared suite for one implementation.
 *
 * One guest is shared by the staging/export/abort tests because creating a real guest is
 * expensive; the credential gate gets its OWN guest, because "refuses before attest" is
 * only meaningful on a guest that has never been attested.
 */
export function defineSandboxConformance(options: ConformanceOptions): void {
  const timeout = options.timeoutMs ?? 5_000;

  describe(`sandbox conformance: ${options.name}`, () => {
    let target: ConformanceTarget;
    let sandbox: Sandbox;
    let digest: string;
    let guest: Guest;
    let networkName: string;
    let guestName: string;

    beforeAll(async () => {
      target = await options.create();
      sandbox = target.sandbox;
      networkName = `${target.namePrefix}-net`;
      guestName = `${target.namePrefix}-guest`;
      const image = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: target.contextDir });
      digest = image.digest;
      await sandbox.createNetwork(networkName, {
        allowPublicDns: true,
        allowPublicTcpPorts: [443],
        denyRanges: ["10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"],
      });
      guest = await sandbox.createGuest({
        name: guestName,
        networkName,
        imageDigest: digest,
        limits: target.limits ?? SAFE_DEFAULT_LIMITS,
        policy: target.policy,
        env: { HOME: "/home/agent", EVAL_CONDITION: "baseline" },
      });
    }, timeout * 6);

    afterAll(async () => {
      // Every exact identity this suite created is destroyed, on every path.
      await sandbox?.destroyResource("guest", guestName).catch(() => undefined);
      await sandbox?.destroyResource("network", networkName).catch(() => undefined);
      await sandbox?.destroyResource("image", digest).catch(() => undefined);
      await target?.dispose?.().catch(() => undefined);
    }, timeout * 4);

    it("self-labels whether it is a test double", async () => {
      expect(sandbox.testDouble).toBe(options.testDouble);
      expect((await sandbox.probe()).ready).toBe(true);
    });

    it(
      "returns a content-addressed digest and the same digest for the same profile",
      async () => {
        expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        const again = await sandbox.buildImage({ runtimeProfileId: "default", contextDir: target.contextDir });
        expect(again.digest).toBe(digest);
        expect(again.testDouble).toBe(options.testDouble);
      },
      timeout * 6,
    );

    it("answers an exact-identity lookup for a present and an absent resource", async () => {
      expect(await sandbox.inspectResource("guest", guestName)).toBe("present");
      expect(await sandbox.inspectResource("guest", `${guestName}-absent`)).toBe("absent");
      expect(await sandbox.inspectResource("network", networkName)).toBe("present");
      expect(await sandbox.inspectResource("network", `${networkName}-absent`)).toBe("absent");
      expect(await sandbox.inspectResource("image", "sha256:" + "0".repeat(64))).toBe("absent");
    }, timeout);

    it("treats destroying an already-absent identity as benign", async () => {
      expect(await sandbox.destroyResource("guest", `${guestName}-absent`)).toMatchObject({
        status: "already-absent",
        verified: true,
        failure: null,
      });
      expect(await sandbox.destroyNetwork(`${networkName}-absent`)).toMatchObject({
        status: "already-absent",
        verified: true,
      });
      expect(await sandbox.destroyResource("image", "sha256:" + "0".repeat(64))).toMatchObject({
        status: "already-absent",
      });
    }, timeout * 2);

    it("stages files and exports them back within bounds", async () => {
      await guest.stage({
        destDir: "/work",
        files: [
          { path: "config.json", base64: Buffer.from("{}").toString("base64"), mode: 0o644 },
          { path: "nested/notes.md", base64: Buffer.from("hello").toString("base64"), mode: 0o644 },
        ],
        readOnly: false,
      });
      const all = await guest.exportFiles({ root: "/work", maxFiles: 10, maxFileBytes: 1_000, maxTotalBytes: 10_000 });
      expect(all.files.map((file) => file.path).sort()).toEqual(["config.json", "nested/notes.md"]);
      expect(all.truncated).toBe(false);
      expect(Buffer.from(all.files.find((file) => file.path === "nested/notes.md")?.base64 ?? "", "base64").toString()).toBe(
        "hello",
      );

      const bounded = await guest.exportFiles({ root: "/work", maxFiles: 1, maxFileBytes: 1_000, maxTotalBytes: 10_000 });
      expect(bounded.files).toHaveLength(1);
      expect(bounded.truncated).toBe(true);
    }, timeout * 3);

    it("refuses an unsafe staged path", async () => {
      await expectEvalError(
        guest.stage({
          destDir: "/work",
          files: [{ path: "../escape.txt", base64: "", mode: 0o644 }],
          readOnly: false,
        }),
        "path-unsafe",
      );
    }, timeout);

    it("honours an AbortSignal on stage and on export", async () => {
      const controller = new AbortController();
      controller.abort();
      await expectEvalError(
        guest.stage({
          destDir: "/work",
          files: [{ path: "a.txt", base64: "", mode: 0o644 }],
          readOnly: false,
          signal: controller.signal,
        }),
        "interrupted",
      );
      await expectEvalError(
        guest.exportFiles({
          root: "/work",
          maxFiles: 1,
          maxFileBytes: 1,
          maxTotalBytes: 1,
          signal: controller.signal,
        }),
        "interrupted",
      );
    }, timeout);

    it(
      "refuses a credential before attestation and accepts one afterwards",
      async () => {
        const credentialGuestName = `${target.namePrefix}-cred`;
        const fresh = await sandbox.createGuest({
          name: credentialGuestName,
          networkName,
          imageDigest: digest,
          limits: target.limits ?? SAFE_DEFAULT_LIMITS,
          policy: target.policy,
          env: { HOME: "/home/agent", EVAL_CONDITION: "treatment" },
        });
        try {
          const refused = await expectEvalError(
            fresh.deliverCredential({ variable: "GEMINI_API_KEY", value: CONFORMANCE_FAKE_SECRET }),
            "secret-quarantine",
          );
          expect(refused.message).toContain("attested");

          const attestation = await fresh.attest();
          expect(attestation.uid).toBe(target.policy.uid);
          expect(attestation.gid).toBe(target.policy.gid);
          expect(attestation.noNewPrivileges).toBe(true);
          expect(attestation.capabilitiesDropped).toBe(true);
          expect(attestation.readOnlyRoot).toBe(true);
          expect(attestation.hostMounts).toEqual([]);
          expect(attestation.egress.resolverInherited).toBe(false);

          // The OBSERVED record travels with the summary and is what gets sealed. Both
          // implementations must produce it, and it must self-label its producer so a
          // double-produced observation can never be read as a measured one.
          const observed = attestation.observed;
          expect(observed.testDouble).toBe(options.testDouble);
          expect(observed.source).not.toBe("");
          expect(observed.init.uid).toBe(target.policy.uid);
          expect(observed.init.gid).toBe(target.policy.gid);
          expect(observed.init.groups).toEqual([]);
          expect(observed.init.capEff).toMatch(/^0+$/);
          expect(observed.init.noNewPrivs).toBe(true);
          expect(observed.readOnlyRootProbe.readOnly).toBe(true);
          expect(observed.anyResolverPrivate).toBe(false);
          // The declared allowlist is 443 only; the enforced rule is derived from it, and
          // the port-80 probe proves the decision rather than restating it.
          expect([...observed.allowedTcpPorts]).toEqual([443]);
          const port80 = observed.egressProbes.find((probe) => probe.label === "public-80");
          expect(port80?.expectation).toBe("blocked");
          expect(port80?.outcome).toBe("blocked");
          expect(observed.egressProbes.length).toBeGreaterThan(1);
          for (const probe of observed.egressProbes) {
            expect(probe.outcome).toBe(probe.expectation);
            expect(typeof probe.durationMs).toBe("number");
          }
          expect(JSON.stringify(observed)).not.toContain(CONFORMANCE_FAKE_SECRET);

          await expect(
            fresh.deliverCredential({ variable: "GEMINI_API_KEY", value: CONFORMANCE_FAKE_SECRET }),
          ).resolves.toBeUndefined();
          await expectEvalError(
            fresh.deliverCredential({ variable: "gemini_api_key", value: CONFORMANCE_FAKE_SECRET }),
            "secret-quarantine",
          );
          await expectEvalError(
            fresh.deliverCredential({ variable: "GEMINI_API_KEY", value: "" }),
            "credential-missing",
          );
          // Only the variable NAME is ever retained.
          const names = (fresh as unknown as { deliveredCredentialVariables?: readonly string[] })
            .deliveredCredentialVariables;
          expect(names).toEqual(["GEMINI_API_KEY"]);
          expect(JSON.stringify(names)).not.toContain(CONFORMANCE_FAKE_SECRET);
        } finally {
          expect(await fresh.destroy()).toMatchObject({ status: "destroyed" });
          expect(await sandbox.inspectResource("guest", credentialGuestName)).toBe("absent");
        }
      },
      timeout * 8,
    );

    it("refuses a credential-shaped variable in the guest specification", async () => {
      await expectEvalError(
        sandbox.createGuest({
          name: `${target.namePrefix}-rejected`,
          networkName,
          imageDigest: digest,
          limits: target.limits ?? SAFE_DEFAULT_LIMITS,
          policy: target.policy,
          env: { GEMINI_API_KEY: "x" },
        }),
        "secret-quarantine",
      );
    }, timeout);
  });
}
