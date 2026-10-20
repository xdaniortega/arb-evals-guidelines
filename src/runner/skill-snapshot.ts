/**
 * Builds the frozen, read-only copy of the evaluated skill that only the treatment arm
 * receives. The live skill tree is never staged directly, symlinks are refused, and the
 * snapshot is content-hashed so evidence can prove which skill bytes were measured.
 */

import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, sep } from "node:path";
import { assertSafeRelativePath, canonicalJsonSha256, sha256Hex } from "../core/experiment.ts";
import { EvalError } from "../core/types.ts";
import { assertNoSymlinkedAncestor, assertRealDirectory, assertSkillDirSafe, containedPath, locateSkillDir, readRegularFile } from "./case-loader.ts";

export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_FILE_BYTES = 1_048_576;
export const MAX_SKILL_TOTAL_BYTES = 8_388_608;

/**
 * Skill-root files that document a skill's own measured results. They are excluded from
 * the agent-visible snapshot so published benchmark numbers can never become treatment
 * input, and so adding or updating them cannot change the recorded skill tree hash.
 * Matched only at the skill root, so an authored reference page of the same name nested
 * deeper is still measured.
 */
export const EXCLUDED_SKILL_ROOT_FILES: readonly string[] = ["EVALS.md"];

export interface SnapshotFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SkillSnapshot {
  readonly sourcePath: string;
  readonly snapshotDir: string;
  readonly files: readonly SnapshotFile[];
  readonly totalBytes: number;
  readonly treeSha256: string;
}

function pathDepth(path: string): number {
  return path.split(sep).length;
}

function isEexist(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "EEXIST";
}

/**
 * @notice Copies a skill directory into a snapshot directory as read-only regular files and computes its aggregate tree hash.
 * @param input Snapshot options specifying repository root, relative skill path, and target snapshot directory.
 * @returns Skill snapshot record detailing contained files, sizes, individual SHA-256 hashes, and overall tree SHA-256 hash.
 * @dev The snapshot directory must not already exist. Reusing a directory would let stale files from a previous snapshot survive into the treatment guest while the recorded tree hash covered only the files written this time, invalidating the frozen input claim; it is created non-recursively and an existing directory fails with a structured error.
 */
export async function createSkillSnapshot(input: {
  readonly repoRoot: string;
  /** Stable name recorded as `sourcePath`; also the repo-relative location unless `skillDir` is given. */
  readonly skillPath: string;
  /** Skill directory (absolute or relative to `repoRoot`), possibly outside the repository. */
  readonly skillDir?: string;
  readonly snapshotDir: string;
}): Promise<SkillSnapshot> {
  const at = `skill ${input.skillPath}`;

  // The containment check below is purely lexical: resolve() does not resolve symlinks.
  // Without these two assertions a symlinked `skills/` or a symlinked skill directory
  // would cause an arbitrary tree to be snapshotted and staged as the evaluated skill.
  let sourceRoot: string;
  if (input.skillDir !== undefined) {
    // External or in-repo skill directory chosen with --skill: checked inside its own
    // checkout root, and only the stable name is recorded.
    const location = locateSkillDir(input.repoRoot, input.skillDir);
    await assertSkillDirSafe(location, "--skill");
    sourceRoot = location.dir;
  } else {
    await assertNoSymlinkedAncestor(input.repoRoot, input.skillPath, "eval.json#skillPath");
    sourceRoot = containedPath(input.repoRoot, input.skillPath, "eval.json#skillPath");
    await assertRealDirectory(sourceRoot, "eval.json#skillPath");
  }

  const files: SnapshotFile[] = [];
  // Every directory this function creates, so the read-only pass can be applied
  // deepest-first. Making a parent read-only before its children are written would
  // break the copy on a strict filesystem.
  const createdDirs = new Set<string>();
  let totalBytes = 0;

  await mkdir(input.snapshotDir, { recursive: false, mode: 0o755 }).catch((cause: unknown) => {
    if (isEexist(cause)) {
      throw new EvalError(
        "evidence-invalid",
        `${at} snapshot directory already exists and must not be reused: ${input.snapshotDir}`,
        { at, cause },
      );
    }
    throw new EvalError(
      "evidence-invalid",
      `${at} snapshot directory is not creatable: ${input.snapshotDir}`,
      { at, cause },
    );
  });
  createdDirs.add(input.snapshotDir);

  const walk = async (relative: readonly string[]): Promise<void> => {
    const dir = relative.length === 0 ? sourceRoot : containedPath(sourceRoot, relative.join("/"), at);
    const entries = await readdir(dir, { withFileTypes: true }).catch((cause: unknown) => {
      throw new EvalError("input-invalid", `${at} is not readable: ${dir}`, { at, cause });
    });
    for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const relativePath = [...relative, entry.name].join("/");
      if (entry.isSymbolicLink()) {
        throw new EvalError("path-unsafe", `${at} contains a symlink: ${relativePath}`, { at });
      }
      if (entry.isDirectory()) {
        await walk([...relative, entry.name]);
        continue;
      }
      if (!entry.isFile()) {
        throw new EvalError("path-unsafe", `${at} contains a non-regular file: ${relativePath}`, { at });
      }
      // Excluded after the symlink and regular-file guards, so an excluded name can
      // still not be used to smuggle a symlink past this walk.
      if (relative.length === 0 && EXCLUDED_SKILL_ROOT_FILES.includes(entry.name)) continue;
      if (files.length >= MAX_SKILL_FILES) {
        throw new EvalError("input-invalid", `${at} exceeds ${MAX_SKILL_FILES} files`, { at });
      }
      const safePath = assertSafeRelativePath(relativePath, `${at}/${relativePath}`);
      const bytes = await readRegularFile(containedPath(sourceRoot, safePath, at), MAX_SKILL_FILE_BYTES, at);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
        throw new EvalError("input-invalid", `${at} exceeds ${MAX_SKILL_TOTAL_BYTES} total bytes`, { at });
      }
      const destination = containedPath(input.snapshotDir, safePath, `${at} snapshot`);
      const parent = dirname(destination);
      if (!createdDirs.has(parent)) {
        await mkdir(parent, { recursive: true, mode: 0o755 });
        // Record the parent and every intermediate directory under the snapshot root.
        let current = parent;
        while (current.length > input.snapshotDir.length && !createdDirs.has(current)) {
          createdDirs.add(current);
          current = dirname(current);
        }
      }
      await writeFile(destination, bytes, { mode: 0o444, flag: "wx" }).catch((cause: unknown) => {
        if (isEexist(cause)) {
          throw new EvalError(
            "evidence-invalid",
            `${at} snapshot path collides with an existing file: ${safePath}`,
            { at: `${at}/${safePath}`, cause },
          );
        }
        throw new EvalError(
          "evidence-invalid",
          `${at} snapshot file is not writable: ${safePath}`,
          { at: `${at}/${safePath}`, cause },
        );
      });
      files.push({ path: safePath, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
    }
  };

  await walk([]);
  if (files.length === 0) throw new EvalError("input-invalid", `${at} contains no files`, { at });

  // Deepest first, so a parent is never sealed before its children were written.
  const orderedDirs = [...createdDirs].sort((left, right) => pathDepth(right) - pathDepth(left));
  for (const dir of orderedDirs) {
    await chmod(dir, 0o555).catch((cause: unknown) => {
      throw new EvalError("evidence-invalid", `${at} snapshot directory is not sealable: ${dir}`, { at, cause });
    });
  }

  return {
    sourcePath: input.skillPath,
    snapshotDir: input.snapshotDir,
    files,
    totalBytes,
    treeSha256: canonicalJsonSha256(files),
  };
}
