import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAllowlistedEnv } from "../test-guards.ts";

const roots: string[] = [];
const staticFiles = ["Containerfile", ".dockerignore", "configure-egress.sh", "run-measured.mjs"];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "eval-guest-lock-build-"));
  roots.push(root);
  const container = join(root, "container");
  const script = join(root, "scripts/build-guest-runtime.mjs");
  await mkdir(dirname(script), { recursive: true });
  await mkdir(container, { recursive: true });
  await cp(join(process.cwd(), "src"), join(root, "src"), { recursive: true });
  await cp(join(process.cwd(), "scripts/build-guest-runtime.mjs"), script);
  for (const name of [...staticFiles, "image-lock.json"]) {
    await cp(join(process.cwd(), "container", name), join(container, name));
  }
  await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  const run = (...args: string[]) => execFileSync(process.execPath, [script, ...args], {
    cwd: root, encoding: "utf8", env: buildAllowlistedEnv(root), stdio: "pipe",
  });
  const readJson = async (path: string) => JSON.parse(await readFile(join(container, path), "utf8"));
  return { root, container, run, readJson };
}

const digest = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("guest runtime lock maintenance", () => {
  it("refreshes generated and static hashes together without changing the selected runtime", async () => {
    const { root, container, run, readJson } = await fixture();
    const before = await readJson("image-lock.json");
    expect(run()).toContain("refreshed image-lock hashes");
    const lock = await readJson("image-lock.json");
    const manifest = await readJson("guest-runtime/artifact-lock.json");
    const profile = lock.profiles.default;
    for (const key of ["base", "node", "pi", "platform", "user", "aptPackages"]) {
      expect(profile[key]).toEqual(before.profiles.default[key]);
    }
    expect(lock.documentation).toEqual(before.documentation);
    expect(profile.guestRuntime.compiler).toEqual(manifest.compiler);
    expect(profile.guestRuntime.sources).toEqual(manifest.sources);
    expect(profile.guestRuntime.artifacts).toEqual(manifest.artifacts);
    for (const path of [...staticFiles, "guest-runtime/artifact-lock.json", ...Object.keys(manifest.artifacts)]) {
      expect(profile.buildContextFiles[path]).toBe(digest(await readFile(join(container, path))));
    }
    const lockBytes = await readFile(join(container, "image-lock.json"));
    const artifactBytes = await readFile(join(container, "guest-runtime/artifact-lock.json"));
    expect(run("--check")).toContain("no files changed");
    expect(await readFile(join(container, "image-lock.json"))).toEqual(lockBytes);
    expect(await readFile(join(container, "guest-runtime/artifact-lock.json"))).toEqual(artifactBytes);

    // A source edit must be detected before a stale runtime can be used, without repairing it.
    const source = join(root, "src/core/types.ts");
    await writeFile(source, `${await readFile(source, "utf8")}\n// changed source\n`);
    expect(() => run("--check")).toThrow(/Guest runtime locks are stale/);
    expect(await readFile(join(container, "image-lock.json"))).toEqual(lockBytes);
    expect(await readFile(join(container, "guest-runtime/artifact-lock.json"))).toEqual(artifactBytes);
    run();
    expect(run("--check")).toContain("no files changed");
  });

  it("detects drift in duplicated image-lock hashes and keeps standalone output builds isolated", async () => {
    const { root, container, run, readJson } = await fixture();
    run();
    const lock = await readJson("image-lock.json");
    lock.profiles.default.guestRuntime.sources["src/core/types.ts"] = "sha256:stale";
    lock.profiles.default.buildContextFiles.Containerfile = "sha256:stale";
    const staleLock = `${JSON.stringify(lock, null, 2)}\n`;
    await writeFile(join(container, "image-lock.json"), staleLock);
    expect(() => run("--check")).toThrow(/image-lock\.json/);
    expect(await readFile(join(container, "image-lock.json"), "utf8")).toBe(staleLock);

    const output = join(root, "standalone-runtime");
    expect(run("--output-dir", output)).toContain("Compiled");
    expect(run("--check", "--output-dir", output)).toContain("no files changed");
    expect(await readFile(join(container, "image-lock.json"), "utf8")).toBe(staleLock);
  });
});
