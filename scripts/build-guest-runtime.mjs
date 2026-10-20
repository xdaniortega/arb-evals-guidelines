#!/usr/bin/env node
/** Compile the guest SDK closure and refresh its duplicated image-lock hashes; --check writes nothing. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const canonicalOutputRoot = join(root, "container/guest-runtime");
const args = process.argv.slice(2);
const check = args[0] === "--check";
const outputArgs = check ? args.slice(1) : args;
if (outputArgs.length !== 0 && (outputArgs.length !== 2 || outputArgs[0] !== "--output-dir" || !isAbsolute(outputArgs[1]))) {
  throw new Error("usage: build-guest-runtime.mjs [--check] [--output-dir <absolute-directory>]");
}
const outputRoot = outputArgs.length === 0 ? canonicalOutputRoot : resolve(outputArgs[1]);
// An explicit output directory is a standalone build: never change the repository's lock.
const maintainImageLock = outputArgs.length === 0;
const sources = [
  "src/core/types.ts",
  "src/core/timing.ts",
  "src/core/experiment.ts",
  "src/core/secret-scan.ts",
  "src/transport-blocker.ts",
  "src/runner/models.ts",
  "src/artifacts/native-prefix.ts",
  "src/harnesses/pi/export-viewer.ts",
  "src/harnesses/pi/scripted-stream.ts",
  "src/harnesses/pi/mcp-http-client.ts",
  "src/harnesses/pi/mcp-tools.ts",
  "src/harnesses/pi/sdk-session.ts",
  "src/harnesses/pi/terminal-classification.ts",
  "src/harnesses/pi/guest-agent.ts",
];
const expectedCompiler = "5.9.3";
if (ts.version !== expectedCompiler) throw new Error(`guest runtime requires TypeScript ${expectedCompiler}, found ${ts.version}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const generatedFiles = new Set([
  "artifact-lock.json",
  ...sources.map((sourcePath) => sourcePath.replace(/\.ts$/, ".mjs")),
]);
const generatedDirectories = new Set();
for (const file of generatedFiles) {
  let parent = dirname(file);
  while (parent !== ".") {
    generatedDirectories.add(parent.split(sep).join("/"));
    parent = dirname(parent);
  }
}

// Never remove the destination or any caller-owned content. Existing destinations are
// accepted only when empty or when every entry belongs to this compiler's exact closure.
const outputMetadata = await lstat(outputRoot).catch(() => null);
if (outputMetadata !== null && (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink())) {
  throw new Error(`guest runtime output must be an absent or real directory: ${outputRoot}`);
}
const inspectDestination = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const relativePath = relative(outputRoot, absolute).split(sep).join("/");
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error(`guest runtime output contains an unexpected non-regular entry: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      if (!generatedDirectories.has(relativePath)) throw new Error(`guest runtime output contains an unexpected directory: ${relativePath}`);
      await inspectDestination(absolute);
    } else if (!generatedFiles.has(relativePath)) {
      throw new Error(`guest runtime output contains an unexpected file: ${relativePath}`);
    }
  }
};
if (outputMetadata !== null) await inspectDestination(outputRoot);

const sourceDigests = {};
const artifactDigests = {};
const compiledFiles = new Map();
for (const sourcePath of sources) {
  const source = await readFile(join(root, sourcePath), "utf8");
  sourceDigests[sourcePath] = `sha256:${sha256(source)}`;
  const result = ts.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      verbatimModuleSyntax: true,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false,
    },
  });
  const errors = (result.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new Error(ts.formatDiagnostics(errors, { getCanonicalFileName: (v) => v, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
  const relativeSource = sourcePath;
  const outputPath = relativeSource.replace(/\.ts$/, ".mjs");
  const compiled = result.outputText.replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, "$1$2.mjs$1");
  compiledFiles.set(outputPath, compiled);
  artifactDigests[`guest-runtime/${relativeSource.replace(/\.ts$/, ".mjs")}`] = `sha256:${sha256(compiled)}`;
}
const manifest = {
  schemaVersion: 1,
  compiler: { package: "typescript", version: expectedCompiler },
  sources: sourceDigests,
  artifacts: artifactDigests,
};
const artifactLockText = `${JSON.stringify(manifest, null, 2)}\n`;
compiledFiles.set("artifact-lock.json", artifactLockText);

const imageLockPath = join(root, "container/image-lock.json");
let imageLock;
let updatedImageLock;
if (maintainImageLock) {
  imageLock = JSON.parse(await readFile(imageLockPath, "utf8"));
  updatedImageLock = structuredClone(imageLock);
  const profile = updatedImageLock.profiles?.default;
  if (!profile?.buildContextFiles || !profile.guestRuntime) throw new Error("image-lock.json omits the default guest runtime identity");
  const staticContextFiles = ["Containerfile", ".dockerignore", "configure-egress.sh", "run-measured.mjs"];
  const staticKeys = Object.keys(profile.buildContextFiles).filter((path) => !path.startsWith("guest-runtime/")).sort();
  if (!isDeepStrictEqual(staticKeys, [...staticContextFiles].sort())) {
    throw new Error("image-lock.json has an unexpected static build-context file set; review it before refreshing hashes");
  }
  const contextDigests = {};
  for (const path of staticContextFiles) contextDigests[path] = `sha256:${sha256(await readFile(join(root, "container", path)))}`;
  profile.buildContextFiles = {
    ...contextDigests,
    "guest-runtime/artifact-lock.json": `sha256:${sha256(artifactLockText)}`,
    ...artifactDigests,
  };
  profile.guestRuntime = {
    ...profile.guestRuntime,
    artifactLock: "guest-runtime/artifact-lock.json",
    compiler: manifest.compiler,
    sources: sourceDigests,
    artifacts: artifactDigests,
  };
}

if (check) {
  const stale = [];
  for (const [path, expected] of compiledFiles) {
    const actual = await readFile(join(outputRoot, path), "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (actual !== expected) stale.push(`guest-runtime/${path}`);
  }
  if (maintainImageLock && !isDeepStrictEqual(imageLock, updatedImageLock)) stale.push("image-lock.json");
  if (stale.length > 0) throw new Error(`Guest runtime locks are stale: ${stale.join(", ")}. Run pnpm build:eval-guest to refresh them.`);
  console.log(`Verified ${sources.length} guest runtime modules${maintainImageLock ? " and image-lock hashes" : ""}; no files changed.`);
} else {
  await mkdir(outputRoot, { recursive: true });
  for (const [path, compiled] of compiledFiles) {
    const target = join(outputRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await unlink(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await writeFile(target, compiled, { mode: path.endsWith("guest-agent.mjs") ? 0o555 : 0o444 });
  }
  if (maintainImageLock) await writeFile(imageLockPath, `${JSON.stringify(updatedImageLock, null, 2)}\n`);
  console.log(`Compiled ${sources.length} locked guest runtime modules with TypeScript ${ts.version}${maintainImageLock ? " and refreshed image-lock hashes" : ""}.`);
}
