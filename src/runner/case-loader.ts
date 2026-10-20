/**
 * Discovery, strict decoding, containment, and freezing of suite and case inputs.
 *
 * Every path is validated before it is joined to a root, every input file must be a
 * regular file reached without traversing a symlink, and the result is a frozen,
 * content-hashed snapshot. Oracle and validator inputs are host-only and are never
 * part of a guest image or workspace.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  assertSafeRelativePath,
  assertSafeSelector,
  canonicalJson,
  canonicalJsonSha256,
  sha256Hex,
} from "../core/experiment.ts";
// Case discovery only ever reads authored source for a NEW run, so it decodes at the
// fresh boundary: no authored collection mode, effective policy `workspace`.
import { EvalError, WORKSPACE_OUTPUT_MARKER, decodeFreshCaseConfig, decodeSuiteConfig } from "../core/types.ts";
import type { CaseConfig, DecodeConfigOptions, PreparedCaseData, RuntimeProfileId, SuiteConfig } from "../core/types.ts";
import { decodeRubric } from "./rubric.ts";
import type { Rubric } from "./rubric.ts";

export const MAX_FIXTURE_FILES = 64;
export const MAX_FIXTURE_FILE_BYTES = 1_048_576;
export const MAX_CASE_JSON_BYTES = 262_144;
export const MAX_VALIDATOR_FILES = 32;
export const MAX_VALIDATOR_FILE_BYTES = 262_144;
export const MAX_VALIDATOR_TOTAL_BYTES = 1_048_576;
export const ALLOWED_VALIDATOR_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;

export interface FrozenFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly base64: string;
}

export interface SuiteRef {
  readonly id: string;
  readonly dir: string;
  readonly config: SuiteConfig;
  /** Canonical cases reuse the retained suite schema without authoring an eval.json. */
  readonly authoredCase?: CaseRef;
}

export interface CaseRef {
  readonly suiteId: string;
  readonly selector: string;
  readonly dir: string;
  readonly config: CaseConfig;
}

export interface FrozenCase {
  readonly suite: SuiteConfig;
  readonly suiteDir: string;
  readonly selector: string;
  readonly caseDir: string;
  readonly config: CaseConfig;
  readonly promptSha256: string;
  readonly fixtureFiles: readonly FrozenFile[];
  readonly fixtureTreeSha256: string;
  readonly oracle: unknown;
  readonly oracleSha256: string;
  readonly oracleBytes: Buffer;
  readonly validatorPath: string;
  readonly validatorEntryPath: string;
  readonly validatorSha256: string;
  readonly validatorBytes: Buffer;
  readonly validatorBundle: readonly FrozenFile[];
  readonly validatorClosureSha256: string;
  readonly runtimeProfileId: RuntimeProfileId;
  readonly preparationProvenance: Readonly<Record<string, string>> | null;
  readonly rubric?: Rubric;
  readonly rubricBytes?: Buffer;
  readonly rubricSha256?: string;
}

export interface ValidatorClosureResult {
  readonly entryPath: string;
  readonly entryBytes: Buffer;
  readonly entrySha256: string;
  readonly bundle: readonly FrozenFile[];
  readonly closureSha256: string;
}

export function validatorClosureHash(entryPath: string, bundle: readonly FrozenFile[]): string {
  return canonicalJsonSha256({
    entryPath,
    files: bundle.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      bytes: file.bytes,
    })),
  });
}

/**
 * Freezes the complete bounded static dependency closure of a validator.
 *
 * Deterministically traverses static ESM imports, re-exports, and side-effect imports
 * using TypeScript's AST parser. Node builtins are allowed without snapshot. All
 * dependencies must be explicit relative .ts/.mts/.js/.mjs files strictly contained within
 * the case root. Circular dependencies are safely handled via DFS visited tracking.
 */
export async function freezeValidatorClosure(
  caseDir: string,
  validatorRelPath: string,
  at: string,
): Promise<ValidatorClosureResult> {
  const entrySafePath = assertSafeRelativePath(validatorRelPath, `${at}#validator`);
  const hasAllowedExt = ALLOWED_VALIDATOR_EXTENSIONS.some((ext) => entrySafePath.endsWith(ext));
  if (!hasAllowedExt) {
    throw new EvalError(
      "input-invalid",
      `${at} validator entry must have an explicit .ts, .mts, .js, or .mjs extension: ${entrySafePath}`,
      { at: `${at}#validator` },
    );
  }
  await assertNoSymlinkedAncestor(caseDir, entrySafePath, `${at}#validator`);

  const visited = new Map<string, FrozenFile>();
  let totalBytes = 0;
  const caseRootAbs = resolve(caseDir);

  const visit = async (relPath: string): Promise<void> => {
    if (visited.has(relPath)) {
      return;
    }
    if (visited.size >= MAX_VALIDATOR_FILES) {
      throw new EvalError(
        "input-invalid",
        `${at} validator dependency closure exceeds maximum ${MAX_VALIDATOR_FILES} files`,
        { at },
      );
    }
    const absPath = containedPath(caseDir, relPath, `${at}/${relPath}`);
    const fileBytes = await readRegularFile(absPath, MAX_VALIDATOR_FILE_BYTES, `${at}/${relPath}`);
    if (totalBytes + fileBytes.byteLength > MAX_VALIDATOR_TOTAL_BYTES) {
      throw new EvalError(
        "input-invalid",
        `${at} validator dependency closure exceeds maximum ${MAX_VALIDATOR_TOTAL_BYTES} bytes`,
        { at },
      );
    }
    totalBytes += fileBytes.byteLength;

    const frozenFile: FrozenFile = {
      path: relPath,
      bytes: fileBytes.byteLength,
      sha256: sha256Hex(fileBytes),
      base64: fileBytes.toString("base64"),
    };
    visited.set(relPath, frozenFile);

    const sourceText = fileBytes.toString("utf8");
    const sourceFile = ts.createSourceFile(absPath, sourceText, ts.ScriptTarget.Latest, true);

    const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      const first = parseDiagnostics[0]!;
      const msg = typeof first.messageText === "string" ? first.messageText : first.messageText.messageText;
      throw new EvalError("input-invalid", `${at}/${relPath} parse error: ${msg}`, { at });
    }

    if (
      sourceFile.typeReferenceDirectives.length > 0 ||
      sourceFile.referencedFiles.length > 0 ||
      sourceFile.libReferenceDirectives.length > 0
    ) {
      throw new EvalError("input-invalid", `${at}/${relPath} contains forbidden type reference directives`, { at });
    }

    const specifiers: string[] = [];
    const walkNode = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          throw new EvalError("path-unsafe", `${at}/${relPath} contains forbidden dynamic import()`, { at });
        }
        if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          throw new EvalError("path-unsafe", `${at}/${relPath} contains forbidden require() call`, { at });
        }
      }
      if (ts.isImportEqualsDeclaration(node)) {
        throw new EvalError("path-unsafe", `${at}/${relPath} contains forbidden import-equals declaration`, { at });
      }
      if (ts.isExportAssignment(node) && node.isExportEquals) {
        throw new EvalError("path-unsafe", `${at}/${relPath} contains forbidden export-equals assignment`, { at });
      }
      if (ts.isImportTypeNode(node)) {
        throw new EvalError("path-unsafe", `${at}/${relPath} contains forbidden import type node`, { at });
      }
      if (ts.isImportDeclaration(node)) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) {
          throw new EvalError("input-invalid", `${at}/${relPath} import specifier must be a string literal`, { at });
        }
        specifiers.push(node.moduleSpecifier.text);
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) {
          throw new EvalError("input-invalid", `${at}/${relPath} re-export specifier must be a string literal`, { at });
        }
        specifiers.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, walkNode);
    };
    walkNode(sourceFile);

    for (const specifier of specifiers) {
      if (isBuiltin(specifier)) {
        continue;
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new EvalError(
          "path-unsafe",
          `${at}/${relPath} imports non-relative or bare package specifier: ${specifier}`,
          { at },
        );
      }
      if (specifier.includes("\0") || specifier.includes("\\")) {
        throw new EvalError(
          "path-unsafe",
          `${at}/${relPath} import specifier contains forbidden characters: ${specifier}`,
          { at },
        );
      }
      const specHasAllowedExt = ALLOWED_VALIDATOR_EXTENSIONS.some((ext) => specifier.endsWith(ext));
      if (!specHasAllowedExt) {
        throw new EvalError(
          "input-invalid",
          `${at}/${relPath} import specifier lacks an explicit allowed extension (.ts, .mts, .js, .mjs): ${specifier}`,
          { at },
        );
      }

      const currentFileDir = dirname(absPath);
      const targetAbs = resolve(currentFileDir, specifier);
      if (targetAbs === caseRootAbs || !targetAbs.startsWith(`${caseRootAbs}${sep}`)) {
        throw new EvalError(
          "path-unsafe",
          `${at}/${relPath} import specifier escapes case root: ${specifier}`,
          { at },
        );
      }

      const targetRel = relative(caseRootAbs, targetAbs).split(sep).join("/");
      const safeTargetRel = assertSafeRelativePath(targetRel, `${at}/${relPath} -> ${specifier}`);
      await assertNoSymlinkedAncestor(caseDir, safeTargetRel, `${at}/${safeTargetRel}`);
      await visit(safeTargetRel);
    }
  };

  await visit(entrySafePath);

  const sortedBundle = [...visited.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entryFile = visited.get(entrySafePath)!;
  const closureSha256 = validatorClosureHash(entrySafePath, sortedBundle);

  return {
    entryPath: entrySafePath,
    entryBytes: Buffer.from(entryFile.base64, "base64"),
    entrySha256: entryFile.sha256,
    bundle: sortedBundle,
    closureSha256,
  };
}

/**
 * Rejects a symlinked, hardlinked, or non-regular input and returns its bytes.
 *
 * The file is opened once with O_NOFOLLOW | O_NONBLOCK and every subsequent decision is made against
 * the open descriptor via fstat. A separate lstat-then-readFile pair would leave a
 * TOCTOU window in which the path could be swapped for a symlink between the check and
 * the read, and it could not see that the inode is also reachable from outside the case
 * directory. `nlink === 1` closes the hardlink case, which lexical containment cannot.
 * Nonblocking open ensures a FIFO is rejected by fstat without waiting for a writer.
 */
export async function readRegularFile(path: string, maxBytes: number, at: string): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch((cause: unknown) => {
    const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new EvalError("path-unsafe", `${at} must not be a symlink: ${path}`, { at, cause });
    }
    throw new EvalError("input-invalid", `${at} is not readable: ${path}`, { at, cause });
  });
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new EvalError("path-unsafe", `${at} must be a regular file: ${path}`, { at });
    }
    if (stats.nlink !== 1) {
      throw new EvalError(
        "path-unsafe",
        `${at} must not be a hardlinked file (nlink=${stats.nlink}): ${path}`,
        { at },
      );
    }
    if (stats.size > maxBytes) {
      throw new EvalError("input-invalid", `${at} exceeds ${maxBytes} bytes: ${path}`, { at });
    }
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Resolves a relative path under a root and proves the result stays inside it. */
export function containedPath(root: string, relativePath: string, at: string): string {
  const safeRelative = assertSafeRelativePath(relativePath, at);
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, safeRelative);
  if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${sep}`)) {
    throw new EvalError("path-unsafe", `${at} escapes its root: ${relativePath}`, { at });
  }
  return candidate;
}

/** Proves no path segment between a root and a leaf is a symlink. */
export async function assertNoSymlinkedAncestor(root: string, relativePath: string, at: string): Promise<void> {
  const segments = assertSafeRelativePath(relativePath, at).split("/");
  let current = resolve(root);
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stats = await lstat(current).catch((cause: unknown) => {
      throw new EvalError("input-invalid", `${at} has an unreadable ancestor: ${current}`, { at, cause });
    });
    if (stats.isSymbolicLink()) {
      throw new EvalError("path-unsafe", `${at} traverses a symlink: ${current}`, { at });
    }
    if (!stats.isDirectory()) {
      throw new EvalError("path-unsafe", `${at} has a non-directory ancestor: ${current}`, { at });
    }
  }
}

/**
 * Proves that a path is itself a real directory, not a symlink to one.
 *
 * containedPath() is purely lexical (resolve() does not resolve symlinks) and
 * freezeDirectory() only inspects the CHILDREN it walks, so without this check a
 * symlinked root would be followed by readdir and an arbitrary tree would be frozen
 * into evidence and staged into a guest.
 */
export async function assertRealDirectory(
  path: string,
  at: string,
  options: { readonly allowMissing?: boolean } = {},
): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (cause: unknown) {
    if (options.allowMissing && (cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new EvalError("input-invalid", `${at} is not readable: ${path}`, { at, cause });
  }
  if (stats.isSymbolicLink()) {
    throw new EvalError("path-unsafe", `${at} must not be a symlink: ${path}`, { at });
  }
  if (!stats.isDirectory()) {
    throw new EvalError("path-unsafe", `${at} must be a directory: ${path}`, { at });
  }
  return true;
}

async function readJsonFile(path: string, at: string): Promise<unknown> {
  const bytes = await readRegularFile(path, MAX_CASE_JSON_BYTES, at);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause: unknown) {
    throw new EvalError("input-invalid", `${at} is not valid JSON: ${path}`, { at, cause });
  }
}

async function directoryEntries(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/** Repository-root directories that are never legacy suites. */
const LEGACY_SCAN_SKIP: ReadonlySet<string> = new Set([
  "src", "scripts", "container", "cases", "eval-cases", "node_modules", "dist", "docs",
]);

/** Directory holding authored cases as `eval-cases/<case-id>/`. */
export const EVAL_CASES_DIR = "eval-cases";

export interface CaseDirectory {
  readonly caseId: string;
  readonly dir: string;
}

/**
 * @notice Lists `eval-cases/<case-id>` directories (real directories only, no symlinks).
 * @param evalsRoot Repository root.
 * @returns Case directories sorted by case id; empty when `eval-cases` is absent.
 */
export async function listCaseDirectories(evalsRoot: string): Promise<readonly CaseDirectory[]> {
  const casesRoot = join(evalsRoot, EVAL_CASES_DIR);
  if (!(await assertRealDirectory(casesRoot, EVAL_CASES_DIR, { allowMissing: true }))) return [];
  let caseIds: readonly string[];
  try {
    caseIds = await directoryEntries(casesRoot);
  } catch (cause: unknown) {
    throw new EvalError("input-invalid", `${EVAL_CASES_DIR} is not readable: ${casesRoot}`, { at: EVAL_CASES_DIR, cause });
  }
  return caseIds.map((caseId) => ({ caseId, dir: containedPath(casesRoot, caseId, `${EVAL_CASES_DIR}/${caseId}`) }));
}

export async function discoverSuites(evalsRoot: string, options?: DecodeConfigOptions): Promise<readonly SuiteRef[]> {
  const suites: SuiteRef[] = [];
  const seenIds = new Set<string>();
  for (const name of await directoryEntries(evalsRoot)) {
    if (LEGACY_SCAN_SKIP.has(name)) continue;
    const dir = containedPath(evalsRoot, name, name);
    const configPath = join(dir, "eval.json");
    const exists = await lstat(configPath).then((stats) => stats.isFile()).catch(() => false);
    if (!exists) continue;
    const config = decodeSuiteConfig(await readJsonFile(configPath, `${name}/eval.json`), `${name}/eval.json`, options);
    if (config.id !== name) {
      throw new EvalError("input-invalid", `${name}/eval.json id must equal its directory name`, { at: `${name}/eval.json` });
    }
    if (seenIds.has(config.id)) {
      throw new EvalError("input-invalid", `duplicate suite id: ${config.id}`, { at: `${name}/eval.json` });
    }
    seenIds.add(config.id);
    suites.push({ id: config.id, dir, config });
  }
  return suites;
}

export async function discoverCases(suite: SuiteRef, options?: DecodeConfigOptions): Promise<readonly CaseRef[]> {
  if (suite.authoredCase !== undefined) return [suite.authoredCase];
  const casesRoot = join(suite.dir, "cases");
  const found: CaseRef[] = [];
  const seenIds = new Map<string, string>();

  const walk = async (relative: readonly string[]): Promise<void> => {
    const dir = relative.length === 0 ? casesRoot : containedPath(casesRoot, relative.join("/"), "case directory");
    const configPath = join(dir, "case.json");
    const hasCase = await lstat(configPath).then((stats) => stats.isFile()).catch(() => false);
    if (hasCase) {
      const selector = assertSafeSelector(relative.join("/"), "case selector");
      const at = `${suite.id}/cases/${selector}/case.json`;
      const config = decodeFreshCaseConfig(await readJsonFile(configPath, at), at, options);
      const previous = seenIds.get(config.id);
      if (previous !== undefined) {
        throw new EvalError("input-invalid", `duplicate case id ${config.id} in ${previous} and ${selector}`, { at });
      }
      seenIds.set(config.id, selector);
      found.push({ suiteId: suite.id, selector, dir, config });
      return;
    }
    for (const name of await directoryEntries(dir)) {
      await walk([...relative, name]);
    }
  };

  await walk([]);
  return [...found].sort((left, right) => (left.selector < right.selector ? -1 : 1));
}

/** One authored task per eval-cases/<case-id>/case.json; the folder name is the case id. */
export async function discoverAuthoredCases(evalsRoot: string, options?: DecodeConfigOptions): Promise<readonly CaseRef[]> {
  const cases: CaseRef[] = [];
  const seen = new Map<string, string>();
  for (const { caseId, dir } of await listCaseDirectories(evalsRoot)) {
    const configPath = join(dir, "case.json");
    const exists = await lstat(configPath).then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) continue;
    const at = `${EVAL_CASES_DIR}/${caseId}/case.json`;
    const config = decodeFreshCaseConfig(await readJsonFile(configPath, at), at, options);
    if (config.id !== caseId) throw new EvalError("input-invalid", `${at} id must equal its directory name`, { at });
    const previous = seen.get(config.id);
    if (previous !== undefined) {
      throw new EvalError("input-invalid", `duplicate case id ${config.id}: ${previous} and ${at}`, { at });
    }
    seen.set(config.id, at);
    cases.push({ suiteId: config.id, selector: config.id, dir, config });
  }
  return cases;
}

export interface SetupSelection {
  readonly evalsRoot: string;
  readonly repoRoot?: string;
  /** Legacy authored suite selector; retained evidence keeps this namespace field. */
  readonly suiteId?: string | null;
  readonly caseSelector?: string | null;
  /**
   * Directory of exactly one treatment skill. Absolute, or relative to `repoRoot` (the CLI
   * resolves it against the working directory first). It may live outside this repository.
   */
  readonly skillPath?: string | null;
}

/** Where a skill directory lives and the stable, host-independent name recorded for it. */
export interface SkillDirLocation {
  /** Absolute skill directory. Host-specific: never written to evidence. */
  readonly dir: string;
  /** Directory whose descendants are checked for symlinks: the checkout holding `skills/<name>`, else the parent. */
  readonly root: string;
  /** `dir` relative to `root`: `skills/<name>` or `<name>`. */
  readonly relative: string;
  /** Stable path recorded in evidence; equal to `relative`. */
  readonly sourcePath: string;
}

/**
 * @notice Resolves a skill directory path to its absolute location and stable recorded name.
 * @param base Directory that relative paths resolve against.
 * @param input Absolute or relative skill directory path.
 * @returns The location. The recorded `sourcePath` is `skills/<name>` when the directory sits under a `skills/` folder, otherwise `<name>`; the absolute host path is never part of it.
 */
export function locateSkillDir(base: string, input: string): SkillDirLocation {
  if (typeof input !== "string" || input === "" || input.includes("\0")) {
    throw new EvalError("path-unsafe", "--skill must be a non-empty directory path", { at: "--skill" });
  }
  const dir = resolve(base, input);
  const name = basename(dir);
  const parent = dirname(dir);
  const underSkills = basename(parent) === "skills" && dirname(parent) !== parent;
  const root = underSkills ? dirname(parent) : parent;
  const relative = underSkills ? `skills/${name}` : name;
  return { dir, root, relative: assertSafeRelativePath(relative, "--skill"), sourcePath: assertSafeRelativePath(relative, "--skill") };
}

/** Proves the skill directory is real and no directory between its checkout root and it is a symlink. */
export async function assertSkillDirSafe(location: SkillDirLocation, at: string): Promise<void> {
  await assertNoSymlinkedAncestor(location.root, location.relative, at);
  await assertRealDirectory(location.dir, at);
}

/**
 * @notice Resolves canonical cases or legacy suites for run and validation setup.
 * @param input Explicit suite or case-and-skill selection.
 * @param options Configuration decoding constraints, including allowed profiles.
 * @returns Suite references without rewriting historical receipts.
 */
export async function resolveSetupSuites(input: SetupSelection, options?: DecodeConfigOptions): Promise<readonly SuiteRef[]> {
  if (input.skillPath != null && input.suiteId != null) {
    throw new EvalError("input-invalid", "--suite conflicts with --skill; select a canonical case with --case <id> --skill <path>", { at: "--suite" });
  }
  if (input.skillPath != null) {
    const location = locateSkillDir(input.repoRoot ?? input.evalsRoot, input.skillPath);
    const skillPath = location.sourcePath;
    await assertSkillDirSafe(location, "--skill");
    await readRegularFile(join(location.dir, "SKILL.md"), 1_048_576, "--skill/SKILL.md");
    const discovered = await discoverAuthoredCases(input.evalsRoot, options);
    const selected = input.caseSelector == null ? discovered : [resolveCaseSelector(discovered, input.caseSelector)];
    if (selected.length === 0) throw new EvalError("input-invalid", `no authored case found under ${input.evalsRoot}`, { at: "--case" });
    return selected.map((entry) => ({
      id: entry.config.id,
      dir: entry.dir,
      config: decodeSuiteConfig({ schemaVersion: 1, id: entry.config.id, skillPath }, `setup/${entry.config.id}`, options),
      authoredCase: entry,
    }));
  }
  const suites = await discoverSuites(input.evalsRoot, options);
  const selected = input.suiteId == null ? suites : suites.filter((suite) => suite.id === input.suiteId);
  if (selected.length === 0) {
    throw new EvalError("input-invalid", input.suiteId == null
      ? "No legacy suite found. Select a treatment setup with --case <case-id> --skill <path>."
      : `--suite ${input.suiteId} matched no suite. Use --case <case-id> --skill <path> for canonical cases.`,
    { at: input.suiteId == null ? "--skill" : "--suite" });
  }
  return selected;
}

export async function resolveCaseSetup(input: SetupSelection & { readonly caseSelector: string }, options?: DecodeConfigOptions): Promise<{ suite: SuiteRef; selected: CaseRef }> {
  const suites = await resolveSetupSuites(input, options);
  if (suites.length !== 1) throw new EvalError("selector-ambiguous", "Select exactly one case and treatment skill with --case <case-id> --skill <path>", { at: "--case" });
  const suite = suites[0]!;
  return { suite, selected: resolveCaseSelector(await discoverCases(suite, options), input.caseSelector) };
}

/** Exact selector match first, then unique case-id or leaf-name match. */
export function resolveCaseSelector(cases: readonly CaseRef[], selector: string): CaseRef {
  const requested = assertSafeSelector(selector, "--case");
  const exact = cases.filter((entry) => entry.selector === requested);
  if (exact.length === 1 && exact[0] !== undefined) return exact[0];
  const loose = cases.filter(
    (entry) => entry.config.id === requested || entry.selector.split("/").at(-1) === requested,
  );
  if (loose.length === 1 && loose[0] !== undefined) return loose[0];
  if (loose.length > 1) {
    throw new EvalError(
      "selector-ambiguous",
      `--case ${requested} matches ${loose.length} cases: ${loose.map((entry) => entry.selector).join(", ")}`,
      { at: "--case" },
    );
  }
  throw new EvalError(
    "input-invalid",
    `--case ${requested} matched no case. Known cases: ${cases.map((entry) => entry.selector).join(", ") || "(none)"}`,
    { at: "--case" },
  );
}

async function freezeDirectory(root: string, at: string): Promise<readonly FrozenFile[]> {
  const files: FrozenFile[] = [];

  // Defence in depth: callers assert this too, but readdir() follows a symlinked root,
  // so the guarantee must not depend on remembering to check at the call site.
  await assertRealDirectory(root, at);

  // Check for a tracked empty directory represented ONLY by a zero-byte root .gitkeep.
  const rootEntries = await readdir(root, { withFileTypes: true }).catch((cause: unknown) => {
    throw new EvalError("input-invalid", `${at} is not readable: ${root}`, { at, cause });
  });
  if (rootEntries.length === 1 && rootEntries[0]?.name === ".gitkeep") {
    const keepEntry = rootEntries[0];
    if (keepEntry.isSymbolicLink()) {
      throw new EvalError("path-unsafe", `${at} contains a symlink: .gitkeep`, { at });
    }
    if (!keepEntry.isFile()) {
      throw new EvalError("path-unsafe", `${at} contains a non-regular file: .gitkeep`, { at });
    }
    const keepPath = join(root, ".gitkeep");
    const keepHandle = await open(keepPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((cause: unknown) => {
      throw new EvalError("input-invalid", `${at} is not readable: ${keepPath}`, { at, cause });
    });
    try {
      const stats = await keepHandle.stat();
      if (stats.size === 0) {
        // Tracked empty directory represented only by a zero-byte root .gitkeep:
        // treat that sole marker as packaging metadata, excluded from logical fixture hashes and staging.
        return [];
      }
    } finally {
      await keepHandle.close().catch(() => undefined);
    }
    // If .gitkeep is not 0 bytes, fall through so it gets rejected by path safety (dotfile).
  }

  const walk = async (relative: readonly string[]): Promise<void> => {
    const dir = relative.length === 0 ? root : containedPath(root, relative.join("/"), at);
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
      if (files.length >= MAX_FIXTURE_FILES) {
        throw new EvalError("input-invalid", `${at} exceeds ${MAX_FIXTURE_FILES} files`, { at });
      }
      const safePath = assertSafeRelativePath(relativePath, `${at}/${relativePath}`);
      const bytes = await readRegularFile(containedPath(root, safePath, at), MAX_FIXTURE_FILE_BYTES, at);
      files.push({
        path: safePath,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        base64: bytes.toString("base64"),
      });
    }
  };

  await walk([]);
  return files;
}

export function fixtureTreeHash(files: readonly FrozenFile[]): string {
  return canonicalJsonSha256(files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })));
}

/** Loads one case and freezes every input it depends on. */
export async function loadFrozenCase(input: {
  readonly evalsRoot: string;
  readonly suiteId?: string;
  readonly repoRoot?: string;
  readonly skillPath?: string;
  readonly caseSelector: string;
  readonly prepared?: PreparedCaseData;
  readonly profileCatalog?: Readonly<Record<string, unknown>>;
  readonly allowedProfileIds?: readonly string[];
}): Promise<FrozenCase> {
  const decodeOptions: DecodeConfigOptions = {
    allowedProfileIds: input.allowedProfileIds,
    profileCatalog: input.profileCatalog,
  };
  const { suite, selected } = await resolveCaseSetup(input, decodeOptions);
  return freezeCase(suite, selected, input.prepared);
}

/**
 * @notice Captures and cryptographically hashes suite configuration, case fixtures, oracle data, and validator closures to bind evaluation inputs.
 * @param suite Resolved evaluation suite reference and directory.
 * @param selected Resolved evaluation case configuration and directory.
 * @param prepared Optional pre-generated oracle and fixture files from trusted preparation.
 * @returns Immutable frozen case structure containing SHA-256 digests and file payloads for grading.
 * @dev Hashes computed during task freezing become sealed evidence recorded in the run receipt to detect any post-freeze input mutation.
 */
export async function freezeCase(
  suite: SuiteRef,
  selected: CaseRef,
  prepared?: PreparedCaseData,
): Promise<FrozenCase> {
  return { suite: suite.config, suiteDir: suite.dir, ...await freezeTask(selected, suite.config.runtimeProfileId, prepared) };
}

/** Freeze task bytes without requiring any evaluated skill or run setup. */
export async function freezeTask(
  selected: CaseRef,
  fallbackProfileId: RuntimeProfileId = "default",
  prepared?: PreparedCaseData,
): Promise<Omit<FrozenCase, "suite" | "suiteDir">> {
  const at = selected.selector;
  const config = selected.config;

  const validatorClosure = await freezeValidatorClosure(selected.dir, config.validator, at);
  const validatorPath = containedPath(selected.dir, validatorClosure.entryPath, `${at}/case.json#validator`);

  let oracle: unknown;
  let oracleBytes: Buffer;
  let oracleSha256: string;

  if (prepared?.oracle !== undefined) {
    oracle = prepared.oracle;
    oracleBytes = Buffer.from(canonicalJson(oracle, `${at}/prepared-oracle`), "utf8");
    oracleSha256 = sha256Hex(oracleBytes);
  } else {
    const oraclePath = containedPath(selected.dir, config.oracle, `${at}/case.json#oracle`);
    await assertNoSymlinkedAncestor(selected.dir, config.oracle, `${at}/case.json#oracle`);
    oracleBytes = await readRegularFile(oraclePath, MAX_CASE_JSON_BYTES, `${at}/${config.oracle}`);
    try {
      oracle = JSON.parse(oracleBytes.toString("utf8")) as unknown;
    } catch (cause: unknown) {
      throw new EvalError("input-invalid", `${at}/${config.oracle} is not valid JSON`, { at, cause });
    }
    oracleSha256 = sha256Hex(oracleBytes);
  }

  let fixtureFiles: readonly FrozenFile[];
  if (prepared?.fixtureFiles !== undefined) {
    if (prepared.fixtureFiles.length > MAX_FIXTURE_FILES) {
      throw new EvalError("input-invalid", `${at} prepared fixture exceeds ${MAX_FIXTURE_FILES} files`, { at });
    }
    const seenPaths = new Set<string>();
    const preparedFiles: FrozenFile[] = [];
    for (const file of prepared.fixtureFiles) {
      const safePath = assertSafeRelativePath(file.path, `${at}/prepared-fixture/${file.path}`);
      if (seenPaths.has(safePath)) {
        throw new EvalError("input-invalid", `${at} prepared fixture contains duplicate path: ${safePath}`, { at });
      }
      seenPaths.add(safePath);
      const bytes = Buffer.isBuffer(file.content)
        ? file.content
        : typeof file.content === "string"
          ? Buffer.from(file.content, "utf8")
          : Buffer.from(file.content);
      if (bytes.byteLength > MAX_FIXTURE_FILE_BYTES) {
        throw new EvalError("input-invalid", `${at}/prepared-fixture/${safePath} exceeds ${MAX_FIXTURE_FILE_BYTES} bytes`, { at });
      }
      preparedFiles.push({
        path: safePath,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        base64: bytes.toString("base64"),
      });
    }
    preparedFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    fixtureFiles = preparedFiles;
  } else {
    await assertNoSymlinkedAncestor(selected.dir, config.fixtureDir, `${at}/case.json#fixtureDir`);
    const fixtureRoot = containedPath(selected.dir, config.fixtureDir, `${at}/case.json#fixtureDir`);
    await assertRealDirectory(fixtureRoot, `${at}/case.json#fixtureDir`);
    fixtureFiles = await freezeDirectory(fixtureRoot, `${at}/${config.fixtureDir}`);
  }

  const isWorkspaceMarker = config.outputPath === WORKSPACE_OUTPUT_MARKER;
  if (config.candidateMode === "file" && isWorkspaceMarker) {
    throw new EvalError(
      "input-invalid",
      `${at}/case.json outputPath cannot be ${WORKSPACE_OUTPUT_MARKER} in file candidateMode`,
      { at: `${at}/case.json#outputPath` },
    );
  }
  if (!isWorkspaceMarker) {
    assertSafeRelativePath(config.outputPath, `${at}/case.json#outputPath`);
  }

  // Optional rubric.json: if present in the case directory, decode and freeze it
  let rubric: Rubric | undefined;
  let rubricBytes: Buffer | undefined;
  let rubricSha256: string | undefined;
  const rubricPath = containedPath(selected.dir, "rubric.json", `${at}/rubric.json`);
  const hasRubric = await lstat(rubricPath).then((s) => !s.isSymbolicLink() && s.isFile()).catch(() => false);
  if (hasRubric) {
    await assertNoSymlinkedAncestor(selected.dir, "rubric.json", `${at}/rubric.json`);
    rubricBytes = await readRegularFile(rubricPath, MAX_CASE_JSON_BYTES, `${at}/rubric.json`);
    let rubricJson: unknown;
    try {
      rubricJson = JSON.parse(rubricBytes.toString("utf8")) as unknown;
    } catch (cause: unknown) {
      throw new EvalError("input-invalid", `${at}/rubric.json is not valid JSON`, { at: `${at}/rubric.json`, cause });
    }
    rubric = decodeRubric(rubricJson, `${at}/rubric.json`);
    rubricSha256 = sha256Hex(rubricBytes);
  }

  return {
    selector: selected.selector,
    caseDir: selected.dir,
    config,
    promptSha256: sha256Hex(config.prompt),
    fixtureFiles,
    fixtureTreeSha256: fixtureTreeHash(fixtureFiles),
    oracle,
    oracleSha256,
    oracleBytes,
    validatorPath,
    validatorEntryPath: validatorClosure.entryPath,
    validatorSha256: validatorClosure.entrySha256,
    validatorBytes: validatorClosure.entryBytes,
    validatorBundle: validatorClosure.bundle,
    validatorClosureSha256: validatorClosure.closureSha256,
    runtimeProfileId: config.runtimeProfileId ?? fallbackProfileId,
    preparationProvenance: prepared?.provenance ?? null,
    ...(rubric !== undefined && rubricBytes !== undefined && rubricSha256 !== undefined
      ? { rubric, rubricBytes, rubricSha256 }
      : {}),
  };
}
