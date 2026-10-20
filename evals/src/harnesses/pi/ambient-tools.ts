/**
 * Ambient custom tools provided by the evaluator.
 *
 * Implements Amendment 9 Slice S2:
 * - Ambient tools are evaluator-provided, registered identically in BOTH arms.
 * - S2 provides the ambient `glob` tool. Pi 0.85.0 has no built-in glob; it is
 *   supplied via createAgentSession({ customTools: [...] }).
 * - Order is governed by EVAL_AMBIENT_TOOL_NAMES, not caller order.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { EvalError } from "../../core/types.ts";

export const EVAL_AMBIENT_TOOL_NAMES = ["glob"] as const;
export const GLOB_MAX_ENTRIES = 500;
export const GLOB_MAX_VISITED = 20_000;
export const GLOB_MAX_DEPTH = 12;
export const GLOB_MAX_RESULT_BYTES = 32 * 1024;
export const GLOB_MAX_PATTERN_LENGTH = 200;
export const GLOB_TRUNCATION_MARKER = "[truncated]";

export interface GlobToolInput {
  readonly pattern: string;
  readonly limit?: number;
}

function errorResult(message: string): AgentToolResult<unknown> & { isError: boolean } {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: { error: message },
    isError: true,
  };
}

function successResult(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: undefined,
  };
}

// Compiles a glob pattern into ONE anchored RegExp over the whole workspace-relative POSIX path.
//
// Grammar rules:
// - double-star slash -> zero or more whole segments
// - trailing slash double-star -> this directory and everything under it
// - double-star elsewhere -> any characters including slash
// - star -> any run of characters except slash
// - question-mark -> exactly one character except slash
// - everything else literal (regex-escaped).
export function compileGlobPattern(pattern: string): RegExp {
  // Consecutive `**/` tokens are semantically identical to one, but each compiles to a
  // nested `(?:[^/]+/)*` quantifier. Left alone, a pattern such as `**/**/**/...x` makes
  // matching backtrack catastrophically and stalls the guest's event loop inside the
  // measured window, which would surface as a bogus task-limit outcome. Collapse first.
  const collapsed = pattern.replace(/(?:\*\*\/)+/g, "**/");
  const source = collapsed;
  let regexStr = "^";
  let i = 0;
  while (i < source.length) {
    if (i > 0 && source.slice(i) === "/**") {
      regexStr += "/.*";
      i += 3;
    } else if (source.slice(i, i + 3) === "**/") {
      regexStr += "(?:[^/]+/)*";
      i += 3;
    } else if (source.slice(i, i + 2) === "**") {
      regexStr += ".*";
      i += 2;
    } else if (source[i] === "*") {
      regexStr += "[^/]*";
      i += 1;
    } else if (source[i] === "?") {
      regexStr += "[^/]";
      i += 1;
    } else {
      const ch = source[i]!;
      regexStr += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Creates the evaluator-provided `glob` tool rooted at `cwd`.
 */
export function createGlobTool(cwd: string): ToolDefinition {
  return {
    name: "glob",
    label: "glob",
    description:
      `Search for files by glob pattern relative to the workspace directory. ` +
      `Returns matching file paths relative to the search directory, byte-sorted. ` +
      `Output is truncated to ${GLOB_MAX_ENTRIES} results or ${GLOB_MAX_RESULT_BYTES / 1024}KB (whichever is hit first).`,
    promptSnippet: "Find files by glob pattern relative to workspace",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match files relative to the workspace directory",
        },
        limit: {
          type: "integer",
          description: `Maximum number of files to return (1-${GLOB_MAX_ENTRIES}, default ${GLOB_MAX_ENTRIES})`,
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId: string, params: any, signal?: AbortSignal): Promise<AgentToolResult<unknown>> {
      if (signal?.aborted) {
        return errorResult("Operation aborted");
      }

      const pattern = params?.pattern;
      if (typeof pattern !== "string") {
        return errorResult("pattern must be a string");
      }
      if (pattern.length === 0) {
        return errorResult("pattern cannot be empty");
      }
      if (pattern.length > GLOB_MAX_PATTERN_LENGTH) {
        return errorResult(`pattern exceeds maximum length of ${GLOB_MAX_PATTERN_LENGTH}`);
      }
      if (pattern.includes("\0")) {
        return errorResult("pattern contains NUL byte");
      }
      if (pattern.startsWith("/") || /^[a-zA-Z]:/.test(pattern)) {
        return errorResult("absolute pattern not allowed");
      }
      if (pattern.includes("..")) {
        return errorResult("path traversal '..' not allowed in pattern");
      }
      if (pattern.includes("\\")) {
        return errorResult("backslash not allowed in pattern");
      }
      if (/[{}[\]!()|]/.test(pattern)) {
        return errorResult("unsupported glob metacharacter");
      }

      const limitParam = params?.limit;
      if (
        limitParam !== undefined &&
        (typeof limitParam !== "number" ||
          !Number.isInteger(limitParam) ||
          limitParam < 1 ||
          limitParam > GLOB_MAX_ENTRIES)
      ) {
        return errorResult(`limit must be an integer between 1 and ${GLOB_MAX_ENTRIES}`);
      }

      const effectiveLimit = Math.min(limitParam ?? GLOB_MAX_ENTRIES, GLOB_MAX_ENTRIES);
        const globRegex = compileGlobPattern(pattern);

      // Verify workspace root can be read
      let rootEntries: Dirent[];
      try {
        rootEntries = await readdir(cwd, { withFileTypes: true });
      } catch (err: any) {
        return errorResult(`unreadable workspace root: ${err?.message ?? String(err)}`);
      }

      const matchingFiles: string[] = [];
      let skippedSymlinks = 0;
      let visitedCount = 0;
      let truncated = false;

      async function walk(relDir: string, entries: Dirent[], depth: number): Promise<void> {
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

        for (const entry of entries) {
          if (signal?.aborted) {
            return;
          }

          if (visitedCount >= GLOB_MAX_VISITED) {
            truncated = true;
            return;
          }
          visitedCount += 1;

          if (entry.isSymbolicLink()) {
            skippedSymlinks += 1;
            continue;
          }

          const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;

          // Safety check: accumulated relative path must have no empty, '.', or '..' segments
          const segments = relPath.split("/");
          if (segments.some((seg: string) => seg === "" || seg === "." || seg === "..")) {
            continue;
          }

          if (entry.isFile()) {
            if (globRegex.test(relPath)) {
              matchingFiles.push(relPath);
            }
          } else if (entry.isDirectory()) {
            if (depth >= GLOB_MAX_DEPTH) {
              // Pruning at the depth cap hides matches, so it must be reported like the
              // other caps rather than returning a silently incomplete list.
              truncated = true;
            } else {
              let subEntries: Dirent[];
              try {
                subEntries = await readdir(join(cwd, relPath), { withFileTypes: true });
              } catch {
                // Ignore per-directory read errors and continue
                continue;
              }
              await walk(relPath, subEntries, depth + 1);
              if (truncated || signal?.aborted) {
                return;
              }
            }
          }
          // Skip non-regular entries (fifos, sockets, devices)
        }
      }

      await walk("", rootEntries, 0);

      if (signal?.aborted) {
        return errorResult("Operation aborted");
      }

      // Determinism: byte-sort matching files
      matchingFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      // Cap 2: keep only the first limit entries after sorting
      if (matchingFiles.length > effectiveLimit) {
        matchingFiles.splice(effectiveLimit);
        truncated = true;
      }

      // Assemble preliminary lines. The symlink disclosure and the truncation marker are
      // appended AFTER the byte-cap trim below so neither can be dropped by it.
      let lines: string[];
      if (matchingFiles.length === 0) {
        lines = truncated ? [] : ["no files matched"];
      } else {
        lines = [...matchingFiles];
      }

      const suffixLines: string[] = [];
      if (skippedSymlinks > 0) {
        suffixLines.push(`[skipped ${skippedSymlinks} symlink(s)]`);
      }

      // Cap 3: result bytes limit (and truncation marker handling)
      if (truncated) {
        lines.push(GLOB_TRUNCATION_MARKER);
      }

      let output = [...lines, ...suffixLines].join("\n");
      if (Buffer.byteLength(output, "utf8") > GLOB_MAX_RESULT_BYTES) {
        truncated = true;
        // Remove trailing marker if already present before dropping lines
        if (lines[lines.length - 1] === GLOB_TRUNCATION_MARKER) {
          lines.pop();
        }
        while (
          lines.length > 0 &&
          Buffer.byteLength([...lines, GLOB_TRUNCATION_MARKER, ...suffixLines].join("\n"), "utf8") > GLOB_MAX_RESULT_BYTES
        ) {
          lines.pop();
        }
        lines.push(GLOB_TRUNCATION_MARKER);
        output = [...lines, ...suffixLines].join("\n");
      }

      return successResult(output);
    },
  };
}

const ambientToolFactories: Record<string, (cwd: string) => ToolDefinition> = {
  glob: createGlobTool,
};

/**
 * The tool definitions both arms receive. Order follows EVAL_AMBIENT_TOOL_NAMES, not the caller.
 */
export function buildAmbientTools(names: readonly string[], cwd: string): readonly ToolDefinition[] {
  const nameSet = new Set<string>();
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(ambientToolFactories, name)) {
      throw new EvalError("input-invalid", `Unknown ambient tool: "${name}"`);
    }
    nameSet.add(name);
  }
  const result: ToolDefinition[] = [];
  for (const toolName of EVAL_AMBIENT_TOOL_NAMES) {
    if (nameSet.has(toolName)) {
      result.push(ambientToolFactories[toolName]!(cwd));
    }
  }
  return result;
}
