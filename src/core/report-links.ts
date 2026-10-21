/**
 * Pure helpers that turn a repository URL and a run folder into a report link.
 * No fs, process or network access: the URL is read once at the process boundary.
 */

import { assertSafeRelativePath } from "./experiment.ts";
import { EvalError } from "./types.ts";

const OWNER_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const REPO_NAME = /^[A-Za-z0-9._-]+$/;

function refuse(message: string): never {
  throw new EvalError("input-invalid", `repository url refused: ${message}`, { at: "repository" });
}

function build(owner: string, repoRaw: string): string {
  const repo = repoRaw.replace(/\.git$/, "");
  if (!OWNER_REPO.test(owner) || !REPO_NAME.test(repo) || repo === "." || repo === "..") {
    refuse("owner or repository name has invalid characters");
  }
  return `https://github.com/${owner}/${repo}`;
}

/** Normalizes a GitHub repository reference to `https://github.com/<owner>/<repo>`. */
export function normalizeRepositoryUrl(raw: string): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") refuse("empty value");

  const shorthand = /^github:([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (shorthand) return build(shorthand[1]!, shorthand[2]!);

  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (scp) return build(scp[1]!, scp[2]!);

  const candidate = value.startsWith("git+") ? value.slice(4) : value;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return refuse("not a recognizable GitHub repository reference");
  }
  if (url.protocol === "ssh:") {
    if (url.username !== "git" || url.password !== "") refuse("credentials are not allowed");
  } else if (url.protocol === "https:") {
    if (url.username !== "" || url.password !== "") refuse("credentials are not allowed");
  } else {
    return refuse(`scheme ${url.protocol} is not allowed`);
  }
  if (url.hostname !== "github.com") refuse("only github.com is supported");
  if (url.port !== "") refuse("port is not allowed");
  if (url.search !== "" || url.hash !== "") refuse("query or fragment is not allowed");
  const parts = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length !== 2) refuse("expected <owner>/<repo>");
  return build(parts[0]!, parts[1]!);
}

/** `--repo-url` wins over the package.json `repository` field; otherwise refuse. */
export function resolveRepositoryUrl(flag: string | undefined, packageRepositoryField: string | undefined): string {
  if (flag !== undefined) return normalizeRepositoryUrl(flag);
  if (packageRepositoryField !== undefined) return normalizeRepositoryUrl(packageRepositoryField);
  return refuse("no repository url: pass --repo-url or set `repository` in package.json");
}

export type RunReportLinkTarget = "run-folder" | "full-report";

export function buildRunReportUrl(input: {
  readonly repoUrl: string;
  readonly runRelativeDir: string;
  readonly target: RunReportLinkTarget;
}): string {
  const repoUrl = normalizeRepositoryUrl(input.repoUrl);
  const dir = assertSafeRelativePath(input.runRelativeDir, "runRelativeDir");
  if (input.target === "run-folder") return `${repoUrl}/tree/HEAD/${dir}`;
  return `${repoUrl}/blob/HEAD/${dir}/EVALS-FULL-REPORT.md`;
}
