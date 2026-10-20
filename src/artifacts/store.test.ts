/**
 * Journal and evidence-store invariants.
 *
 * These are the guarantees a reader of a receipt is implicitly trusting: that no sealed
 * path was ever rewritten, that the manifest covers exactly the chained files, that views
 * and recovery records are outside the chain, that no secret can be promoted into
 * evidence, and that cleanup can replay exact identities from the journal.
 */

import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvalError } from "../core/types.ts";
import { canonicalJson, resourceNameFor, sha256Hex } from "../core/experiment.ts";
import {
  createEvidenceStore,
  createRunJournal,
  isChainExcludedPath,
  journaledIdentities,
  readRunJournal,
} from "./store.ts";

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eval-store-test-"));
  created.push(dir);
  return dir;
}

describe("run journal", () => {
  it("reads generated resource names beyond the three-digit repetition padding", async () => {
    const stateDir = join(await tempRoot(), ".state");
    const runId = "19700101T000000Z-abcdef12";
    const nonce = "0a1b2c3d";
    const journal = await createRunJournal({ stateDir, runId, nonce });
    const identities = [
      { kind: "guest" as const, conditionId: "baseline" as const, name: resourceNameFor("guest", { runId, resourceNonce: nonce }, 1000, "baseline") },
      { kind: "network" as const, conditionId: "treatment" as const, name: resourceNameFor("net", { runId, resourceNonce: nonce }, 1000, "treatment") },
    ];
    for (const identity of identities) {
      await journal.record({ ...identity, event: "intent", action: "create", status: null });
    }
    expect(journaledIdentities(await readRunJournal(stateDir, runId))).toEqual(identities);
  });

  it("appends intent before observation and reads back exact identities", async () => {
    const root = await tempRoot();
    const stateDir = join(root, ".state");
    const journal = await createRunJournal({ stateDir, runId: "19700101T000000Z-abcdef12", nonce: "0a1b2c3d" });

    const guestName = "eval-guest-19700101t000000zabcdef12-r001-baseline-0a1b2c3d";
    await journal.record({
      event: "intent",
      action: "create",
      kind: "guest",
      name: guestName,
      conditionId: "baseline",
      status: null,
    });
    await journal.record({
      event: "observed",
      action: "create",
      kind: "guest",
      name: guestName,
      conditionId: "baseline",
      status: "created",
    });

    const entries = await readRunJournal(stateDir, "19700101T000000Z-abcdef12");
    expect(entries.map((entry) => `${entry.event}:${entry.action}:${entry.name}`)).toEqual([
      `intent:create:${guestName}`,
      `observed:create:${guestName}`,
    ]);
    expect(entries[0]?.sequence).toBe(1);
    expect(entries[1]?.sequence).toBe(2);
    expect(entries.every((entry) => entry.nonce === "0a1b2c3d")).toBe(true);

    // Deduplicated exact identities: cleanup and recovery act only on these.
    expect(journaledIdentities(entries)).toEqual([
      { kind: "guest", name: guestName, conditionId: "baseline" },
    ]);
  });

  it("creates the state directory owner-only and writes newline-delimited canonical JSON", async () => {
    const root = await tempRoot();
    const stateDir = join(root, ".state");
    const journal = await createRunJournal({ stateDir, runId: "run-a", nonce: "abcd" });
    await journal.record({
      event: "intent",
      action: "create",
      kind: "network",
      name: "eval-net-a",
      conditionId: null,
      status: null,
    });

    const mode = (await stat(stateDir)).mode & 0o777;
    expect(mode).toBe(0o700);

    const raw = await readFile(journal.path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    // Canonical: keys sorted, no undefined, explicit nulls.
    expect(lines[0]).toBe(canonicalJson(journal.entries()[0]));
  });

  it("rejects mixed run, nonce, and sequence ownership before recovery can act", async () => {
    const root = await tempRoot();
    const stateDir = join(root, ".state");
    const journal = await createRunJournal({ stateDir, runId: "run-owned", nonce: "aaaa" });
    await journal.record({ event: "intent", action: "create", kind: "guest", name: "eval-guest-runowned-r001-baseline-aaaa", conditionId: "baseline", status: null });
    const mixed = { ...journal.entries()[0], sequence: 2, runId: "run-other", nonce: "bbbb", name: "eval-guest-runother-r001-baseline-bbbb" };
    await writeFile(journal.path, `${canonicalJson(mixed)}\n`, { flag: "a" });
    await expect(readRunJournal(stateDir, "run-owned")).rejects.toMatchObject({ code: "evidence-invalid" });
  });

  it("rejects duplicate identities with conflicting condition ownership", async () => {
    const root = await tempRoot();
    const stateDir = join(root, ".state");
    const journal = await createRunJournal({ stateDir, runId: "run-owned", nonce: "aaaa" });
    await journal.record({ event: "intent", action: "create", kind: "guest", name: "eval-guest-runowned-r001-baseline-aaaa", conditionId: "baseline", status: null });
    const first = journal.entries()[0]!;
    expect(() => journaledIdentities([first, { ...first, sequence: 2, conditionId: "treatment" }])).toThrow(/conflicting condition owners/);
  });

  it("reports a missing journal as an evidence defect rather than an empty run", async () => {
    const root = await tempRoot();
    await expect(readRunJournal(join(root, ".state"), "no-such-run")).rejects.toMatchObject({
      code: "evidence-invalid",
    });
  });
});

describe("evidence store", () => {
  it("refuses a second write to a sealed path with evidence-invalid", async () => {
    const runDir = join(await tempRoot(), "run");
    const store = await createEvidenceStore({ runDir });
    await store.writeRecord("inputs/plan.json", { a: 1 });

    const error = await store.writeRecord("inputs/plan.json", { a: 2 }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvalError);
    expect((error as EvalError).code).toBe("evidence-invalid");

    // Not overwritten, not truncated.
    const body = await readFile(join(runDir, "inputs/plan.json"), "utf8");
    expect(JSON.parse(body)).toEqual({ a: 1 });
  });

  it("refuses a path that already exists on disk from an earlier process", async () => {
    const runDir = join(await tempRoot(), "run");
    const first = await createEvidenceStore({ runDir });
    await first.writeRecord("pairs/p/baseline/condition.json", { status: "completed" });

    const second = await createEvidenceStore({ runDir });
    await expect(second.writeRecord("pairs/p/baseline/condition.json", { status: "tampered" })).rejects.toMatchObject(
      { code: "evidence-invalid" },
    );
  });

  it("builds a manifest over chained records and binds it from the receipt", async () => {
    const runDir = join(await tempRoot(), "run");
    const store = await createEvidenceStore({ runDir });
    await store.writeRecord("inputs/case.json", { id: "c" });
    await store.writeRecord("pairs/p/pair.json", { pairId: "p" });
    await store.writeView("summary.txt", "regenerable");

    const manifest = await store.sealManifest();
    expect(manifest.tree.entries.map((entry) => entry.path)).toEqual(["inputs/case.json", "pairs/p/pair.json"]);
    // Views live outside the hash chain.
    expect(manifest.tree.entries.some((entry) => entry.path.startsWith("views/"))).toBe(false);

    await store.sealReceipt({ manifest: { treeSha256: manifest.tree.treeSha256, fileSha256: manifest.fileSha256 } });
    const manifestBytes = await readFile(join(runDir, "manifest.json"));
    expect(sha256Hex(manifestBytes)).toBe(manifest.fileSha256);
  });

  it("refuses a receipt before the manifest is sealed and a record after it", async () => {
    const runDir = join(await tempRoot(), "run");
    const store = await createEvidenceStore({ runDir });
    await expect(store.sealReceipt({})).rejects.toMatchObject({ code: "evidence-invalid" });
    await store.writeRecord("inputs/a.json", { a: 1 });
    await store.sealManifest();
    await expect(store.writeRecord("inputs/b.json", { b: 2 })).rejects.toMatchObject({ code: "evidence-invalid" });
    await expect(store.sealManifest()).rejects.toMatchObject({ code: "evidence-invalid" });
  });

  it("quarantines a secret instead of writing it, retaining only a redacted record", async () => {
    const runDir = join(await tempRoot(), "run");
    const secretValue = "fake-not-a-real-key-abcdefghijklmnop";
    const store = await createEvidenceStore({
      runDir,
      guardedSecrets: [{ label: "FAKE_PROVIDER_KEY", value: secretValue }],
    });

    const error = await store
      .writeRecord("pairs/p/treatment/workspace.json", { text: secretValue })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(EvalError);
    expect((error as EvalError).code).toBe("secret-quarantine");

    const body = await readFile(join(runDir, "pairs/p/treatment/workspace.json"), "utf8");
    expect(body).not.toContain(secretValue);
    const redacted = JSON.parse(body) as { quarantined: boolean; hits: Array<{ label: string; encoding: string }> };
    expect(redacted.quarantined).toBe(true);
    expect(redacted.hits[0]?.label).toBe("FAKE_PROVIDER_KEY");
    // A hit names the label and the encoding, never the value.
    expect(JSON.stringify(redacted)).not.toContain(secretValue);
  });

  it("manifests the redacted quarantine record so it sits inside the verified hash chain", async () => {
    const runDir = join(await tempRoot(), "run");
    const secretValue = "fake-not-a-real-key-abcdefghijklmnop";
    const store = await createEvidenceStore({
      runDir,
      guardedSecrets: [{ label: "FAKE_PROVIDER_KEY", value: secretValue }],
    });
    const path = "pairs/p/treatment/workspace.json";
    await expect(store.writeRecord(path, { text: secretValue })).rejects.toMatchObject({
      code: "secret-quarantine",
    });

    // The redacted record IS evidence: it must be covered by the manifest, not left in an
    // unverified region of the tree. It carries a label and an encoding, never a value.
    const entry = store.entries().find((candidate) => candidate.path === path);
    expect(entry).toBeDefined();
    const body = await readFile(join(runDir, path), "utf8");
    expect(entry?.sha256).toBe(sha256Hex(body));
    expect(entry?.bytes).toBe(Buffer.byteLength(body));
    expect(body).not.toContain(secretValue);

    const manifest = await store.sealManifest();
    expect(manifest.tree.entries.map((candidate) => candidate.path)).toContain(path);
  });

  it("detects a base64-encoded secret echo, not only the raw spelling", async () => {
    const runDir = join(await tempRoot(), "run");
    const secretValue = "fake-not-a-real-key-abcdefghijklmnop";
    const store = await createEvidenceStore({
      runDir,
      guardedSecrets: [{ label: "FAKE_PROVIDER_KEY", value: secretValue }],
    });
    const encoded = Buffer.from(`prefix:${secretValue}:suffix`, "utf8").toString("base64");
    await expect(store.writeRecord("pairs/p/baseline/workspace.json", { base64: encoded })).rejects.toMatchObject({
      code: "secret-quarantine",
    });
  });

  it("reserves manifest.json, receipt.json, views/ and recovery/ from chained records", async () => {
    const runDir = join(await tempRoot(), "run");
    const store = await createEvidenceStore({ runDir });
    for (const reserved of ["manifest.json", "receipt.json", "views/x.json", "recovery/r/x.json"]) {
      await expect(store.writeRecord(reserved, { a: 1 })).rejects.toMatchObject({ code: "evidence-invalid" });
      expect(isChainExcludedPath(reserved)).toBe(true);
    }
    expect(isChainExcludedPath("pairs/p/pair.json")).toBe(false);
  });

  it("rejects an unsafe evidence path before it is joined to the run directory", async () => {
    const runDir = join(await tempRoot(), "run");
    const store = await createEvidenceStore({ runDir });
    for (const unsafe of ["../escape.json", "/absolute.json", "pairs//p.json", "a/../../b.json"]) {
      await expect(store.writeRecord(unsafe, { a: 1 })).rejects.toMatchObject({ code: "path-unsafe" });
    }
  });

  it("never creates a symlink or a mutable pointer in a run directory", async () => {
    const runDir = join(await tempRoot(), "run");
    const store = await createEvidenceStore({ runDir });
    await store.writeRecord("inputs/a.json", { a: 1 });
    await store.sealManifest();
    await store.sealReceipt({ manifest: { treeSha256: "x", fileSha256: "y" } });
    await store.writeView("summary.txt", "hello");

    const names: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        expect(entry.isSymbolicLink()).toBe(false);
        names.push(entry.name);
        if (entry.isDirectory()) await walk(join(dir, entry.name));
      }
    };
    await walk(runDir);
    expect(names).not.toContain("latest");
  });

  it("writes chained records read-only so an accidental rewrite fails loudly", async () => {
    const runDir = join(await tempRoot(), "run");
    const store = await createEvidenceStore({ runDir });
    await store.writeRecord("inputs/a.json", { a: 1 });
    const path = join(runDir, "inputs/a.json");
    expect((await stat(path)).mode & 0o222).toBe(0);
    // Restore write permission only to prove the mode was the thing blocking it.
    await chmod(path, 0o644);
    await writeFile(path, "{}");
  });
});
