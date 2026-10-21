# AGENTS.md

Entry point for coding agents working in this repository, the developer-only evaluation subsystem. This condenses [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (the owner-controlled contract) and [`docs/open-items.md`](docs/open-items.md) (everything unsettled). When this file and the contract disagree, **the contract wins**. Operator how-to lives in [`README.md`](README.md).

> `docs/` is **local-only** (git-ignored). It exists in the owner's working copy but not in clones, and this file is the tracked summary of it. If `docs/` is missing, treat the rules below as the contract and ask the owner before changing any guarantee.

## What this subsystem does

It measures the effect of **one skill bundle** on **one task** by running two fresh, isolated arms from the **same image digest**:

- **baseline**: the harness runtime and no evaluated skill.
- **treatment**: the same runtime, one frozen copy of the skill and the MCP servers that skill declares.

The only permitted difference between the arms is skill presence, meaning its prose plus the tools it declares. Grading is deterministic code run in a separate offline, credential-free guest. Evidence is sealed and hash-chained, and every report is recomputed from it.

It is **not** part of the published CLI, MCP server or package, and it is not a benchmark, a statistical authority, an offline sandbox, a plugin framework or an LLM judge.

## Layout and ownership

| Path | Owns |
| --- | --- |
| `src/core/` | Pure meaning: IDs, schemas, limits, parity, scheduling, path safety, canonical hashing. **No** fs/process/network/provider imports, and no case/skill/provider branches. |
| `src/runner/` | Orchestration: preflight, freezing, arm sequencing, rubric scoring (`rubric.ts`), validation dispatch, cleanup, sealing, recovery, doctor. |
| `src/harnesses/` | How a prompt is executed (Pi SDK inside the guest, and fake test doubles). |
| `src/sandboxes/` | Images, networks, guests, staging, bounded export and destruction (Apple Container, fake). |
| `src/artifacts/` | Journals, immutable seals and verified read models: `store.ts`, `queries.ts` (run report and pair selection), `scored-report.ts` (shared terminal/Markdown/JSON model and the `EVALS.md` summary renderer), `run-exports.ts` (render, write and check the two run-folder reports), `publish.ts` (`exportRun`). |
| `scripts/` | Thin argument parsing and composition only, with no policy. |
| `container/` | Guest build context, image lock, egress policy and guest supervisor. |
| `src/test-fixtures/` | Synthetic skills used only by tests. They are not real skills. |
| `eval-cases/<case-id>/` | Case data: `case.json`, `rubric.json`, `fixture/` (agent workspace), `oracle.json` (hidden golden data), `validator.ts`, tests, and an optional `README.md` (documentation only, not evidence, no tool reads it; generic sections: Why this case exists, The task, How to run it, Scoring rubric, Provenance, Additional context (optional), Results). The folder name equals the case id. A case is not tied to a skill: `--skill` chooses the treatment skill at run time and the run records it in `inputs/skill-snapshot.json` (`sourcePath`). |
| `eval-cases/<case-id>/runs/` | Sealed evidence, committed. Its `views/` folder is git-ignored. Each run keeps a frozen copy of its skill at `inputs/frozen/skill/`, usable as `--skill` to reproduce it. Next to `receipt.json` sit two generated, unsealed files (outside the hash chain via exact root names in `store.ts`, always recomputed from evidence, each embedding `manifest.treeSha256`): `EVALS.md` (marker-free summary; **the only file to export**) and `EVALS-FULL-REPORT.md` (stays in this repo). |
| Skill under test | Any directory with `SKILL.md`, passed to `--skill`. Read-only input, anywhere on disk, no import step. `eval:export --to` only generates `EVALS.md` in a directory you name; it runs no git commands. |
| `.state/` | Ignored exact-ID journals. |

Dependency direction: `scripts → runner → core`. The runner uses harness, sandbox and artifacts, and case data feeds the runner. Environment and argv are parsed **once** at the process boundary. Limits resolve in the order CLI > case > suite > profile > default and are frozen before dispatch.

## Commands

```bash
pnpm eval:doctor --model <id>                       # readiness; no completion requests
pnpm eval --case network-config-01 --skill <path_to_skill> --model <id> [--repetitions N] [--checks]
pnpm eval:history --latest --case network-config-01 # receipts and pair IDs
pnpm eval:report --receipt <receipt.json> [--format table|markdown|json] [--checks]
pnpm eval:inspect --receipt <receipt.json> --pair <full-pair-id> --condition treatment --view session --export both
pnpm eval:export --receipt <receipt.json>                 # default: generate both reports in the run folder
pnpm eval:export --receipt <receipt.json> --check [--all] # --regenerate is an alias of the default
pnpm eval:export --receipt <receipt.json> --to <dir|file.md> [--pair <pair-id|rNNN>] [--repo-url <url>]
pnpm eval:recover --run <exact-run-id>
```

Never edit sealed files under `eval-cases/*/runs/`; only `eval:export --regenerate` may write the two generated reports there. Tests must not depend on an external skills checkout; use `src/test-fixtures/skills/`.

Development checks: `pnpm typecheck:evals`, `pnpm test:evals`, `pnpm test:eval-cases`, `pnpm test:container`, `pnpm eval:validate`. After changing guest runtime sources, run `pnpm build:eval-guest`.

## Key behaviors to know

- **Budgets:** `wallClockMs`, `maxOutputTokens`, `maxToolSteps` and `maxProviderRequests` default to **unlimited** (`null`, which is also what `none` and `0` select). A finite cap applies only when explicitly opted in, and `wallClockMs` starts at each arm's own prompt. Stop causes separate harness-budget exhaustion from provider-native truncation.
- **Scheduling:** Both arms reach a readiness barrier before either is prompted. They overlap by default, and `--serial` keeps the barrier. At most one pair runs at a time, and its cleanup is verified before the next pair starts.
- **Candidate:** Every fresh run grades the bounded final workspace. `file` projection is refused at preflight and survives only in historical evidence.
- **Scoring (rubric v0.2):** Each check belongs to `outcome` (sums to 80) or `constraints` (sums to 20). The runner scores centrally at seal time with `scoreWithRubric`, and any validator scalar is advisory. A full pass requires every check. Evidence without a v0.2 frozen rubric is **legacy** and is never reweighted.
- **Failures:** Task failures are gradeable and may score 0. Infrastructure failures have `score: null`, and the two are never mixed. No delta is computed for a pair that is not gradeable.
- **Run exports:** After a verified run, `pnpm eval` writes `EVALS.md` and `EVALS-FULL-REPORT.md` into the run folder (failure only warns). `eval:export --receipt <receipt>` (alias `--regenerate`) rewrites them, `--check [--all]` fails on missing or stale files (CI runs it). Both embed the run's tree hash; `eval:report` recomputes the chain to verify it. Rendering is deterministic: no timestamps, no host paths.
- **Export:** Evidence is verified first. `eval:export --to <dir | file.md>` writes the run-folder `EVALS.md` wrapped in `<!-- AF-EVAL:BEGIN/END generated -->` markers (created if missing; only the block is replaced, idempotently). `eval:publish` no longer exists. It refuses stale run-folder files.
  - A single-pair run exports that pair.
  - A multi-pair run with no `--pair` exports the **mean over every pair**. The header reads `Run: <id> · Pairs r001, r002, r003`.
  - `--pair` exports one pair.
  - Export is refused if any rendered pair has an ungraded arm.
  - `EVALS.md` is the compact summary (header, badge, pillars, Accuracy Outcome Checks, run hash, absolute `blob/HEAD/.../EVALS-FULL-REPORT.md` link). The full report adds Accuracy, Cost and latency, per-pair results, case description, reproducibility and export instructions. The link uses `--repo-url` or `package.json` `repository`; the git remote is never read.
  - Means are rounded only when rendered: one decimal for accuracy and points, integers for tokens and durations.
- **Sessions:** Sessions are sanitized native Pi sessions. Reasoning is stripped by default and kept only with `--capture-reasoning`, in which case the session is private evidence. Views under `views/` are regenerable and sit outside the hash chain.

## Rules you must not break

- Never break pair parity. The only difference is the skill and the tools its frozen manifest declares; ambient evaluator tools go to both arms.
- Never rely on ambient state, ambient credentials or ambient skill discovery.
- Never put a skill, fixture, oracle, validator, test or answer in an image or build context.
- Never share writable state between conditions, repetitions or runs.
- Never execute guest-authored code on the host.
- Never let a credential, or any scanned encoding of one, reach a file, log, hash, view or artifact.
- Never score an infrastructure failure as a task failure, and never report a delta for an invalid pair.
- Never mutate a built image identity or sealed evidence, and never create a `latest` pointer or symlink into a run.
- Never write a final receipt before every cleanup outcome is known, and never re-run a task automatically to get a better result.
- Never present test-double (fake) evidence as a measured result.
- Never make an ordinary `eval` or `eval:report` modify a skill's `EVALS.md`. (`eval` writes only the two generated files in its own run folder; `eval:report` writes nothing.)
- Never change the published CLI, MCP server or package surface to serve evals.

## Working agreements

- **`docs/ARCHITECTURE.md` is owner-controlled.** Edit it only when the owner explicitly asks for a reconciliation. Repair implementation defects without weakening a guarantee. If a guarantee cannot be met, stop the dependent work and ask.
- **`docs/open-items.md` §A (open questions) is not a backlog.** Do not decide rubric, scoring, badge, task-limit, variability or MCP questions on the owner's behalf. Items in §B (known unsolved issues) may be fixed when requested. §C is deferred, and §D is discarded, so never reintroduce `--from` reproduction, ablation or determinism guarantees.
- Colocate `*.test.ts` with the code under test. Do not modify owner-authored case files to wire tests in.
- Do not edit `docs/ARCHITECTURE.md` to record that the two run-folder reports sit outside the hash chain unless the owner asks for the reconciliation; the owner has approved the guarantee change.
- A new case goes under `eval-cases/<case-id>/` and needs no change to `core/`, harness, sandbox or provider code. A new provider, harness type, N-way variant, remote sandbox or LLM judge needs separate owner approval.
- `docs/` and local planning files (`*plan.md`, `.crew/`) are git-ignored and local-only. Never force-add them.