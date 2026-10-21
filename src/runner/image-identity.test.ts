/**
 * Tests for Image Identity and Ownership (Item 5).
 *
 * Requirements:
 * - Containerfile uses locked base digest, not mutable tag
 * - Wrong image digest is rejected
 * - Warm matching image is reused
 * - Changed recipe identity selects a different image rather than silently reusing old environment
 * - Final run cleanup never deletes a shared cached image or another run's resources
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeSandbox } from "../sandboxes/fake.ts";
import { EvalError, SAFE_DEFAULT_LIMITS } from "../core/types.ts";
import { EVAL_GUEST_POLICY } from "./run.ts";

describe("Image Identity and Pinning", () => {
  it("Containerfile enforces the locked base digest", async () => {
    const containerfilePath = join(process.cwd(), "container", "Containerfile");
    const lockPath = join(process.cwd(), "container", "image-lock.json");

    const containerfile = await readFile(containerfilePath, "utf8");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      profiles: { default: { base: { digest: string } } };
    };

    const lockedDigest = lock.profiles.default.base.digest;
    expect(lockedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Assert Containerfile FROM line includes the locked digest
    expect(containerfile).toContain(`@${lockedDigest}`);
    expect(containerfile).not.toMatch(/^FROM node:24-trixie-slim$/m);
  });

  it("locks the Pi dependency installation with exact version pin", async () => {
    const containerfilePath = join(process.cwd(), "container", "Containerfile");
    const containerfile = await readFile(containerfilePath, "utf8");

    expect(containerfile).toContain("@earendil-works/pi-coding-agent@0.85.0");
    expect(containerfile).toContain("--save-exact");
  });
});

describe("Image Caching, Recipe Identity, and Cleanup Separation", () => {
  it("reuses a warm matching image when recipe is unchanged", async () => {
    const sandbox = createFakeSandbox();

    // Build first time
    const first = await sandbox.buildImage({
      runtimeProfileId: "default",
      contextDir: join(process.cwd(), "container"),
    });

    // Build second time with same spec
    const second = await sandbox.buildImage({
      runtimeProfileId: "default",
      contextDir: join(process.cwd(), "container"),
    });

    // Both identities and digests are identical
    expect(second.digest).toBe(first.digest);
    expect(second.reference).toBe(first.reference);
    // created.images only recorded it once because second build was a warm hit
    expect(sandbox.created.images).toHaveLength(1);
  });

  it("selects a different image when recipe identity changes", async () => {
    const sandbox = createFakeSandbox();

    const imageA = await sandbox.buildImage({
      runtimeProfileId: "default",
      contextDir: join(process.cwd(), "container"),
    });

    // Specifying a different profile creates a different recipe identity
    const imageB = await sandbox.buildImage({
      runtimeProfileId: "other-profile",
      contextDir: join(process.cwd(), "container"),
    });

    expect(imageB.digest).not.toBe(imageA.digest);
    expect(imageB.reference).not.toBe(imageA.reference);
    expect(sandbox.created.images).toHaveLength(2);
  });

  it("rejects an unbuilt or wrong image digest when creating guest", async () => {
    const sandbox = createFakeSandbox();
    const net = await sandbox.createNetwork("eval-net-1", {
      allowPublicDns: true,
      allowPublicTcpPorts: "all",
      denyRanges: [],
    });

    const bogusDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    await expect(
      sandbox.createGuest({
        name: "eval-guest-bogus",
        networkName: net.name,
        imageDigest: bogusDigest,
        env: {},
        limits: SAFE_DEFAULT_LIMITS,
        policy: EVAL_GUEST_POLICY,
      }),
    ).rejects.toThrow(EvalError);
  });

  it("preserves shared cached image during guest/network destruction", async () => {
    const sandbox = createFakeSandbox();

    const image = await sandbox.buildImage({
      runtimeProfileId: "default",
      contextDir: join(process.cwd(), "container"),
    });

    const net = await sandbox.createNetwork("eval-net-cleanup", {
      allowPublicDns: true,
      allowPublicTcpPorts: "all",
      denyRanges: [],
    });

    const guest = await sandbox.createGuest({
      name: "eval-guest-cleanup",
      networkName: net.name,
      imageDigest: image.digest,
      env: {},
      limits: SAFE_DEFAULT_LIMITS,
      policy: EVAL_GUEST_POLICY,
    });

    // Destroy guest and network (per-run cleanup)
    const guestDestroy = await guest.destroy();
    expect(guestDestroy.status).toBe("destroyed");

    const netDestroy = await sandbox.destroyNetwork(net.name);
    expect(netDestroy.status).toBe("destroyed");

    // The shared image is NOT destroyed and remains inspectable/usable
    const imagePresence = await sandbox.inspectResource("image", image.digest);
    expect(imagePresence).toBe("present");
  });
});
