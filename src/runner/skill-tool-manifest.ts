/**
 * Pure parser and snapshot reader for evaluated-skill MCP tool manifests.
 *
 * Declared tool dependencies are part of skill presence.
 * Only the treatment arm provisions declared MCP servers.
 *
 * Note: The repository-root `.claude-plugin/plugin.json` mirrors this declaration
 * for Claude Code but is NOT frozen with the skill and is therefore not read here.
 */

import net from "node:net";
import { sha256Hex } from "../core/experiment.ts";
import {
  EMPTY_SKILL_TOOL_BUNDLE,
  MAX_SKILL_TOOL_MANIFEST_BYTES,
  MAX_SKILL_TOOL_SERVERS,
  SKILL_TOOL_MANIFEST_PATH,
  type SkillToolBundle,
  type SkillToolServer,
} from "../core/skill-tools.ts";
import { EvalError } from "../core/types.ts";
import { containedPath, readRegularFile } from "./case-loader.ts";

const MCP_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ALLOWED_MCP_KEYS = new Set(["type", "value", "description", "transport", "url"]);
const FORBIDDEN_VALUE_START = ["{", "[", "&", "*", "!", "|", ">"] as const;

function isValidDnsHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  if (hostname.startsWith("[") || hostname.endsWith("]")) return false;
  if (net.isIP(hostname) !== 0) return false;
  if (/^(\d+\.){3}\d+$/.test(hostname)) return false;
  const labels = hostname.split(".");
  const lastLabel = labels[labels.length - 1];
  if (labels.length > 1 && lastLabel !== undefined && /^\d+$/.test(lastLabel)) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)) return false;
  }
  return true;
}

function parseScalar(val: string, at: string): string {
  const trimmed = val.trim();
  if (trimmed === "") return "";
  const first = trimmed[0];
  if (first === "{" || first === "[") {
    throw new EvalError("input-invalid", `${at} flow collections not allowed: ${trimmed}`, { at });
  }
  if (first === "&" || first === "*" || first === "!") {
    throw new EvalError("input-invalid", `${at} anchors, aliases, and tags not allowed: ${trimmed}`, { at });
  }
  if (first === "|" || first === ">") {
    throw new EvalError("input-invalid", `${at} block scalars not allowed: ${trimmed}`, { at });
  }

  if (first === '"') {
    let result = "";
    let i = 1;
    let closed = false;
    while (i < trimmed.length) {
      if (trimmed[i] === '"') {
        if (i + 1 < trimmed.length && trimmed[i + 1] === '"') {
          result += '"';
          i += 2;
        } else {
          closed = true;
          i++;
          break;
        }
      } else {
        result += trimmed[i];
        i++;
      }
    }
    if (!closed) {
      throw new EvalError("input-invalid", `${at} unclosed double-quoted string`, { at });
    }
    const remainder = trimmed.slice(i).trim();
    if (remainder !== "" && !remainder.startsWith("#")) {
      throw new EvalError("input-invalid", `${at} trailing characters after quoted string: ${remainder}`, { at });
    }
    return result;
  }

  if (first === "'") {
    let result = "";
    let i = 1;
    let closed = false;
    while (i < trimmed.length) {
      if (trimmed[i] === "'") {
        if (i + 1 < trimmed.length && trimmed[i + 1] === "'") {
          result += "'";
          i += 2;
        } else {
          closed = true;
          i++;
          break;
        }
      } else {
        result += trimmed[i];
        i++;
      }
    }
    if (!closed) {
      throw new EvalError("input-invalid", `${at} unclosed single-quoted string`, { at });
    }
    const remainder = trimmed.slice(i).trim();
    if (remainder !== "" && !remainder.startsWith("#")) {
      throw new EvalError("input-invalid", `${at} trailing characters after quoted string: ${remainder}`, { at });
    }
    return result;
  }

  const commentIndex = trimmed.search(/\s#/);
  return (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trimEnd();
}

function splitKeyValue(line: string): { key: string; value: string } | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('"')) {
    let i = 1;
    let key = "";
    let closed = false;
    while (i < trimmed.length) {
      if (trimmed[i] === '"') {
        if (i + 1 < trimmed.length && trimmed[i + 1] === '"') {
          key += '"';
          i += 2;
        } else {
          closed = true;
          i++;
          break;
        }
      } else {
        key += trimmed[i];
        i++;
      }
    }
    if (!closed) return null;
    const rest = trimmed.slice(i).trimStart();
    if (!rest.startsWith(":")) return null;
    const afterColon = rest.slice(1);
    if (afterColon.length > 0 && !/^\s/.test(afterColon)) return null;
    return { key, value: afterColon.trimStart() };
  }
  if (trimmed.startsWith("'")) {
    let i = 1;
    let key = "";
    let closed = false;
    while (i < trimmed.length) {
      if (trimmed[i] === "'") {
        if (i + 1 < trimmed.length && trimmed[i + 1] === "'") {
          key += "'";
          i += 2;
        } else {
          closed = true;
          i++;
          break;
        }
      } else {
        key += trimmed[i];
        i++;
      }
    }
    if (!closed) return null;
    const rest = trimmed.slice(i).trimStart();
    if (!rest.startsWith(":")) return null;
    const afterColon = rest.slice(1);
    if (afterColon.length > 0 && !/^\s/.test(afterColon)) return null;
    return { key, value: afterColon.trimStart() };
  }

  const match = trimmed.match(/^([^:\s]+):\s*(.*)$/);
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return { key: match[1], value: match[2] };
  }
  const endMatch = trimmed.match(/^([^:\s]+):(?:\s*#.*)?$/);
  if (endMatch && endMatch[1] !== undefined) {
    return { key: endMatch[1], value: "" };
  }
  return null;
}

type ParsedYamlValue = string | Map<string, any> | any[];

interface StackFrame {
  indent: number;
  container: Map<string, any> | any[];
  pendingKey?: string;
}

function parseStrictYaml(text: string, at: string): Map<string, any> {
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_TOOL_MANIFEST_BYTES) {
    throw new EvalError(
      "input-invalid",
      `${at} exceeds maximum manifest size of ${MAX_SKILL_TOOL_MANIFEST_BYTES} bytes`,
      { at },
    );
  }
  if (text.includes("\t")) {
    throw new EvalError("input-invalid", `${at} tab character not allowed`, { at });
  }

  const rawLines = text.split(/\r?\n/);
  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "..." || trimmed.startsWith("--- ") || trimmed.startsWith("... ")) {
      throw new EvalError("input-invalid", `${at} document separator not allowed at line ${idx + 1}`, { at });
    }
  }

  const root = new Map<string, any>();
  const stack: StackFrame[] = [{ indent: 0, container: root }];

  for (let lineIdx = 0; lineIdx < rawLines.length; lineIdx++) {
    const raw = rawLines[lineIdx];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indent = raw.search(/\S/);
    if (indent % 2 !== 0) {
      throw new EvalError("input-invalid", `${at} line ${lineIdx + 1} has odd indentation: ${indent}`, { at });
    }
    const depth = indent / 2;
    if (depth > 5) {
      throw new EvalError("input-invalid", `${at} line ${lineIdx + 1} nesting depth exceeds 5`, { at });
    }

    const contentAfterIndent = raw.slice(indent);
    let isSequenceItem = false;
    let content = contentAfterIndent;
    if (contentAfterIndent === "-" || contentAfterIndent.startsWith("- ") || /^-(\s|$)/.test(contentAfterIndent)) {
      isSequenceItem = true;
      content = contentAfterIndent.slice(1).trimStart();
    }

    // Step 1: Resolve pending key on top of stack if present
    const top = stack[stack.length - 1];
    if (!top) continue;
    if (top.pendingKey !== undefined) {
      if (indent === top.indent + 2) {
        if (isSequenceItem) {
          const newSeq: any[] = [];
          (top.container as Map<string, any>).set(top.pendingKey, newSeq);
          delete top.pendingKey;
          stack.push({ indent, container: newSeq });
          if (stack.length > 6) {
            throw new EvalError("input-invalid", `${at} line ${lineIdx + 1} nesting depth exceeds 5`, { at });
          }
        } else {
          const newMap = new Map<string, any>();
          (top.container as Map<string, any>).set(top.pendingKey, newMap);
          delete top.pendingKey;
          stack.push({ indent, container: newMap });
          if (stack.length > 6) {
            throw new EvalError("input-invalid", `${at} line ${lineIdx + 1} nesting depth exceeds 5`, { at });
          }
        }
      } else if (indent <= top.indent) {
        (top.container as Map<string, any>).set(top.pendingKey, null);
        delete top.pendingKey;
      } else {
        throw new EvalError("input-invalid", `${at} line ${lineIdx + 1} invalid indentation jump`, { at });
      }
    }

    // Step 2: Pop stack frames deeper than current indent
    while (stack.length > 1) {
      const topFrame = stack[stack.length - 1];
      if (!topFrame || indent >= topFrame.indent) break;
      const popped = stack.pop()!;
      if (popped.pendingKey !== undefined) {
        (popped.container as Map<string, any>).set(popped.pendingKey, null);
      }
    }

    // Step 3: Ensure current container matches indentation
    const currentTop = stack[stack.length - 1];
    if (!currentTop) continue;

    if (Array.isArray(currentTop.container)) {
      if (!isSequenceItem) {
        throw new EvalError(
          "input-invalid",
          `${at} line ${lineIdx + 1} expected sequence item at indent ${indent}`,
          { at },
        );
      }
      if (indent !== currentTop.indent) {
        throw new EvalError(
          "input-invalid",
          `${at} line ${lineIdx + 1} sequence item indentation mismatch`,
          { at },
        );
      }

      if (content === "" || content.startsWith("#")) {
        const itemMap = new Map<string, any>();
        currentTop.container.push(itemMap);
        stack.push({ indent: indent + 2, container: itemMap });
      } else {
        const first = content[0];
        if (FORBIDDEN_VALUE_START.includes(first as any)) {
          throw new EvalError("input-invalid", `${at} line ${lineIdx + 1} forbidden character: ${first}`, { at });
        }

        const kv = splitKeyValue(content);
        if (kv) {
          const itemMap = new Map<string, any>();
          currentTop.container.push(itemMap);
          const hasInline = kv.value.trim() !== "" && !kv.value.trim().startsWith("#");
          if (hasInline) {
            itemMap.set(kv.key, parseScalar(kv.value, at));
          } else {
            itemMap.set(kv.key, null);
          }
          stack.push({
            indent: indent + 2,
            container: itemMap,
            pendingKey: hasInline ? undefined : kv.key,
          });
        } else {
          const scalar = parseScalar(content, at);
          currentTop.container.push(scalar);
        }
      }
    } else {
      // Container is Map
      if (isSequenceItem) {
        throw new EvalError(
          "input-invalid",
          `${at} line ${lineIdx + 1} unexpected sequence item in mapping`,
          { at },
        );
      }
      if (indent !== currentTop.indent) {
        throw new EvalError(
          "input-invalid",
          `${at} line ${lineIdx + 1} mapping key indentation mismatch`,
          { at },
        );
      }

      const kv = splitKeyValue(content);
      if (!kv) {
        throw new EvalError("input-invalid", `${at} line ${lineIdx + 1} invalid mapping entry: ${content}`, { at });
      }
      if (currentTop.container.has(kv.key)) {
        throw new EvalError("input-invalid", `${at} duplicate key in mapping: ${kv.key}`, { at });
      }

      const hasInline = kv.value.trim() !== "" && !kv.value.trim().startsWith("#");
      if (hasInline) {
        currentTop.container.set(kv.key, parseScalar(kv.value, at));
      } else {
        currentTop.pendingKey = kv.key;
      }
    }
  }

  // Clear any trailing pending keys
  for (const frame of stack) {
    if (frame.pendingKey !== undefined) {
      (frame.container as Map<string, any>).set(frame.pendingKey, null);
      delete frame.pendingKey;
    }
  }

  return root;
}

/** Pure parser: strict minimal YAML subset. Never touches the filesystem. */
export function parseSkillToolBundle(
  text: string,
  sourcePath: string,
  sourceSha256: string,
  at: string,
): SkillToolBundle {
  const root = parseStrictYaml(text, at);
  const dependencies = root.get("dependencies");
  if (dependencies === undefined || dependencies === null) {
    return {
      schemaVersion: 1,
      source: sourcePath,
      sourceSha256,
      servers: [],
    };
  }

  if (!(dependencies instanceof Map)) {
    throw new EvalError("input-invalid", `${at} dependencies must be a mapping`, { at });
  }

  const tools = dependencies.get("tools");
  if (tools === undefined || tools === null) {
    return {
      schemaVersion: 1,
      source: sourcePath,
      sourceSha256,
      servers: [],
    };
  }

  if (!Array.isArray(tools)) {
    throw new EvalError("input-invalid", `${at} dependencies.tools must be a sequence`, { at });
  }

  const servers: SkillToolServer[] = [];
  const seenNames = new Set<string>();

  for (let idx = 0; idx < tools.length; idx++) {
    const entry = tools[idx];
    if (!(entry instanceof Map)) {
      throw new EvalError("input-invalid", `${at} dependencies.tools[${idx}] must be a mapping`, { at });
    }

    const typeVal = entry.get("type");
    if (typeVal !== "mcp") {
      // Ignore non-mcp tool entries
      continue;
    }

    for (const key of entry.keys()) {
      if (!ALLOWED_MCP_KEYS.has(key)) {
        throw new EvalError("input-invalid", `${at} unknown key in mcp entry: ${key}`, { at });
      }
    }

    const value = entry.get("value");
    if (typeof value !== "string" || !MCP_NAME_PATTERN.test(value)) {
      throw new EvalError("input-invalid", `${at} invalid mcp tool value/name: ${String(value)}`, { at });
    }

    if (seenNames.has(value)) {
      throw new EvalError("input-invalid", `${at} duplicate mcp server name: ${value}`, { at });
    }
    seenNames.add(value);

    const transport = entry.get("transport");
    if (transport !== "streamable_http") {
      throw new EvalError(
        "input-invalid",
        `${at} mcp transport must be streamable_http: ${String(transport)}`,
        { at },
      );
    }

    const urlStr = entry.get("url");
    if (typeof urlStr !== "string") {
      throw new EvalError("input-invalid", `${at} mcp url must be a string`, { at });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch {
      throw new EvalError("input-invalid", `${at} invalid mcp url: ${urlStr}`, { at });
    }

    if (parsedUrl.protocol !== "https:") {
      throw new EvalError("input-invalid", `${at} mcp url must use https: protocol`, { at });
    }
    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
      throw new EvalError("input-invalid", `${at} mcp url must not contain userinfo`, { at });
    }
    if (parsedUrl.port !== "" && parsedUrl.port !== "443") {
      throw new EvalError("input-invalid", `${at} mcp url port must be omitted or 443`, { at });
    }
    if (!isValidDnsHostname(parsedUrl.hostname)) {
      throw new EvalError(
        "input-invalid",
        `${at} mcp url host must be a valid DNS hostname (IP literals not allowed): ${parsedUrl.hostname}`,
        { at },
      );
    }

    const desc = entry.get("description");
    let description: string | null = null;
    if (desc !== undefined && desc !== null) {
      if (typeof desc !== "string") {
        throw new EvalError("input-invalid", `${at} mcp description must be a string`, { at });
      }
      description = desc;
    }

    if (servers.length >= MAX_SKILL_TOOL_SERVERS) {
      throw new EvalError(
        "input-invalid",
        `${at} exceeds maximum allowed mcp servers (${MAX_SKILL_TOOL_SERVERS})`,
        { at },
      );
    }

    servers.push({
      name: value,
      transport: "streamable_http",
      url: urlStr,
      description,
    });
  }

  servers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    schemaVersion: 1,
    source: sourcePath,
    sourceSha256,
    servers,
  };
}

/** Reads the manifest from the FROZEN skill snapshot directory; absent file yields EMPTY_SKILL_TOOL_BUNDLE. */
export async function resolveSkillToolBundle(input: {
  readonly snapshotDir: string;
  readonly at: string;
}): Promise<SkillToolBundle> {
  const manifestPath = containedPath(input.snapshotDir, SKILL_TOOL_MANIFEST_PATH, input.at);
  let bytes: Buffer;
  try {
    bytes = await readRegularFile(manifestPath, MAX_SKILL_TOOL_MANIFEST_BYTES, input.at);
  } catch (cause) {
    if (
      cause instanceof EvalError &&
      typeof cause.cause === "object" &&
      cause.cause !== null &&
      (cause.cause as { code?: unknown }).code === "ENOENT"
    ) {
      return EMPTY_SKILL_TOOL_BUNDLE;
    }
    throw cause;
  }
  const hash = sha256Hex(bytes);
  return parseSkillToolBundle(bytes.toString("utf8"), SKILL_TOOL_MANIFEST_PATH, hash, input.at);
}

/**
 * Validates an arbitrary record against the skill tool bundle schema and rules.
 * Enforces: schemaVersion 1, valid source and sourceSha256, transport exactly streamable_http,
 * https: URL, no userinfo, DNS host, port omitted or 443, server count within cap,
 * names valid, sorted and unique.
 */
export function validateSkillToolBundle(bundle: unknown, at = "skill-tool-bundle"): SkillToolBundle {
  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new EvalError("input-invalid", `${at} must be an object`, { at });
  }
  const b = bundle as Record<string, unknown>;
  const allowedBundleKeys = new Set(["schemaVersion", "source", "sourceSha256", "servers"]);
  for (const key of Object.keys(b)) {
    if (!allowedBundleKeys.has(key)) {
      throw new EvalError("input-invalid", `${at} contains unknown key: ${key}`, { at });
    }
  }

  if (b.schemaVersion !== 1) {
    throw new EvalError("input-invalid", `${at}.schemaVersion must be 1`, { at });
  }

  if (b.source !== null && typeof b.source !== "string") {
    throw new EvalError("input-invalid", `${at}.source must be a string or null`, { at });
  }

  if (b.sourceSha256 !== null && (typeof b.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sourceSha256))) {
    throw new EvalError("input-invalid", `${at}.sourceSha256 must be a 64-char lowercase hex digest or null`, { at });
  }

  if (!Array.isArray(b.servers)) {
    throw new EvalError("input-invalid", `${at}.servers must be an array`, { at });
  }

  if (b.servers.length > MAX_SKILL_TOOL_SERVERS) {
    throw new EvalError(
      "input-invalid",
      `${at}.servers exceeds maximum allowed servers (${MAX_SKILL_TOOL_SERVERS})`,
      { at },
    );
  }

  const allowedServerKeys = new Set(["name", "transport", "url", "description"]);
  const validatedServers: SkillToolServer[] = [];

  for (let i = 0; i < b.servers.length; i++) {
    const s = b.servers[i];
    const serverAt = `${at}.servers[${i}]`;
    if (s === null || typeof s !== "object" || Array.isArray(s)) {
      throw new EvalError("input-invalid", `${serverAt} must be an object`, { at: serverAt });
    }
    const serverObj = s as Record<string, unknown>;
    for (const key of Object.keys(serverObj)) {
      if (!allowedServerKeys.has(key)) {
        throw new EvalError("input-invalid", `${serverAt} contains unknown key: ${key}`, { at: serverAt });
      }
    }

    const name = serverObj.name;
    if (typeof name !== "string" || !MCP_NAME_PATTERN.test(name)) {
      throw new EvalError("input-invalid", `${serverAt}.name must be a valid server name`, { at: serverAt });
    }

    if (i > 0 && name <= validatedServers[i - 1]!.name) {
      throw new EvalError("input-invalid", `${at}.servers must be sorted and unique by name`, { at });
    }

    if (serverObj.transport !== "streamable_http") {
      throw new EvalError("input-invalid", `${serverAt}.transport must be streamable_http`, { at: serverAt });
    }

    const urlStr = serverObj.url;
    if (typeof urlStr !== "string") {
      throw new EvalError("input-invalid", `${serverAt}.url must be a string`, { at: serverAt });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch {
      throw new EvalError("input-invalid", `${serverAt}.url is invalid: ${urlStr}`, { at: serverAt });
    }

    if (parsedUrl.protocol !== "https:") {
      throw new EvalError("input-invalid", `${serverAt}.url must use https: protocol`, { at: serverAt });
    }
    if (parsedUrl.username !== "" || parsedUrl.password !== "") {
      throw new EvalError("input-invalid", `${serverAt}.url must not contain userinfo`, { at: serverAt });
    }
    if (parsedUrl.port !== "" && parsedUrl.port !== "443") {
      throw new EvalError("input-invalid", `${serverAt}.url port must be omitted or 443`, { at: serverAt });
    }
    if (!isValidDnsHostname(parsedUrl.hostname)) {
      throw new EvalError(
        "input-invalid",
        `${serverAt}.url host must be a valid DNS hostname (IP literals not allowed): ${parsedUrl.hostname}`,
        { at: serverAt },
      );
    }

    const desc = serverObj.description;
    let description: string | null = null;
    if (desc !== undefined && desc !== null) {
      if (typeof desc !== "string") {
        throw new EvalError("input-invalid", `${serverAt}.description must be a string or null`, { at: serverAt });
      }
      description = desc;
    }

    validatedServers.push({
      name,
      transport: "streamable_http",
      url: urlStr,
      description,
    });
  }

  return {
    schemaVersion: 1,
    source: b.source as string | null,
    sourceSha256: b.sourceSha256 as string | null,
    servers: validatedServers,
  };
}
