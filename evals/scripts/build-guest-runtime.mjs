#!/usr/bin/env node
/** Compile the explicit in-guest SDK source closure with the repository's locked TypeScript. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const canonicalOutputRoot = join(root, "evals/container/guest-runtime");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output-dir" || !isAbsolute(args[1]))) {
  throw new Error("usage: build-guest-runtime.mjs [--output-dir <absolute-directory>]");
}
const outputRoot = args.length === 0 ? canonicalOutputRoot : resolve(args[1]);
const sources = [
  "evals/src/core/types.ts",
  "evals/src/core/experiment.ts",
  "evals/src/core/secret-scan.ts",
  "evals/src/transport-blocker.ts",
  "evals/src/runner/models.ts",
  "evals/src/artifacts/native-prefix.ts",
  "evals/src/harnesses/pi/export-viewer.ts",
  "evals/src/harnesses/pi/scripted-stream.ts",
  "evals/src/harnesses/pi/ambient-tools.ts",
  "evals/src/harnesses/pi/mcp-http-client.ts",
  "evals/src/harnesses/pi/mcp-tools.ts",
  "evals/src/harnesses/pi/sdk-session.ts",
  "evals/src/harnesses/pi/guest-agent.ts",
];
const expectedCompiler = "5.9.3";
if (ts.version !== expectedCompiler) throw new Error(`guest runtime requires TypeScript ${expectedCompiler}, found ${ts.version}`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const generatedFiles = new Set([
  "artifact-lock.json",
  ...sources.map((sourcePath) => relative("evals", sourcePath).replace(/\.ts$/, ".mjs")),
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
else await mkdir(outputRoot, { recursive: true });
for (const file of generatedFiles) await unlink(join(outputRoot, file)).catch((error) => {
  if (error?.code !== "ENOENT") throw error;
});

const sourceDigests = {};
const artifactDigests = {};
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
  const relativeSource = relative("evals", sourcePath);
  const outputPath = join(outputRoot, relativeSource.replace(/\.ts$/, ".mjs"));
  const compiled = result.outputText.replace(/(["'])(\.{1,2}\/[^"']+)\.ts\1/g, "$1$2.mjs$1");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, compiled, { mode: sourcePath.endsWith("guest-agent.ts") ? 0o555 : 0o444 });
  artifactDigests[`guest-runtime/${relativeSource.replace(/\.ts$/, ".mjs")}`] = `sha256:${sha256(compiled)}`;
}
const manifest = {
  schemaVersion: 1,
  compiler: { package: "typescript", version: expectedCompiler },
  sources: sourceDigests,
  artifacts: artifactDigests,
};
await writeFile(join(outputRoot, "artifact-lock.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 });
console.log(`Compiled ${sources.length} locked guest runtime modules with TypeScript ${ts.version}.`);
