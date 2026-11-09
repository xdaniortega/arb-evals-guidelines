# AGENTS.md

Guide for coding agents working in this repository. The root [`README.md`](README.md) is the onboarding page (what an eval is, requirements, quickstart) and routes to the human guides in `docs/`; operator how-to (running, inspecting, exporting) lives in [`docs/running-evals.md`](docs/running-evals.md). This file covers what to know and what not to break when changing code.

## What this repository does

It measures the effect of **one skill** on **one task** by running two fresh, isolated arms from the **same image digest**:

- **baseline**: the harness runtime and no evaluated skill.
- **treatment**: the same runtime, plus one frozen copy of the skill and the MCP servers it declares.

The only permitted difference between the arms is the skill (its prose plus the tools it declares). Grading is deterministic code run in a separate offline, credential-free guest. Evidence is sealed and hash-chained, and every report is recomputed from it.

It is not a benchmark, a statistical authority, an offline sandbox, a plugin framework or an LLM judge.

Source comments may cite `docs/ARCHITECTURE.md`. That is the owner-held contract; it is local-only (`/docs/ARCHITECTURE.md` is git-ignored; the rest of `docs/` is tracked human documentation), and this file is its tracked summary. Without it, treat the rules here as the contract and ask before changing a guarantee.

## Layout

| Path | Purpose |
| --- | --- |
| `src/core/` | Pure logic: IDs, schemas, limits, parity, scheduling, path safety, canonical hashing. No fs, process, network or provider imports, and no case, skill or provider branches. |
| `src/runner/` | Orchestration: preflight, freezing, arm sequencing, rubric scoring, validation dispatch, cleanup, sealing, recovery, doctor. |
| `src/harnesses/` | How a prompt is executed (Pi SDK inside the guest, and fake test doubles). |
| `src/sandboxes/` | Images, networks, guests, staging, bounded export and destruction (Apple Container, fake). |
| `src/artifacts/` | Journals, immutable seals, verified read models, report renderers and the run exports. |
| `scripts/` | Thin argument parsing and composition only. No policy. |
| `container/` | Guest build context, image lock, egress policy and guest supervisor. |
| `src/test-fixtures/` | Synthetic skills used only by tests. They are not real skills. |
| `eval-cases/<case-id>/` | Case data: `case.json`, `rubric.json`, `fixture/` (agent workspace), `oracle.json` (hidden expected answers), `validator.ts`, tests and an optional `README.md` (documentation only). The folder name equals the case id. A case is not tied to a skill: `--skill` chooses it at run time. |
| `eval-cases/<case-id>/runs/` | Sealed evidence, committed. `views/` is git-ignored. Each run keeps a frozen copy of its skill under `inputs/frozen/skill/`. |
| `eval-cases/<case-id>/runs/EVALS-<run-a>+<run-b>.md` | Generated combined `EVALS.md` of several runs of one case (multi-model `eval` or multi-`--receipt` export). A plain file, never a directory; members come from the file name. |
| `.state/` | Ignored run journals. |

Dependency direction: `src/core/` is the leaf and imports no other layer. `scripts/` compose `runner`, `artifacts` and `sandboxes`, and case data feeds the runner. `runner` and `artifacts` import each other (for example `artifacts/queries.ts` uses `runner/rubric.ts`), so put new shared logic in `core/` instead of adding more cross-imports. Environment and argv are parsed once, at the process boundary. Limits resolve in the order CLI > case > suite > profile > default and are frozen before dispatch.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm eval:validate --case <case-id> --skill <path_to_skill>   # offline input check
pnpm eval:doctor --model <id>                                 # readiness; no completion requests
pnpm eval --case <case-id> --skill <path_to_skill> --model <id> [--repetitions N] [--checks]
pnpm eval:history --latest --case <case-id>                   # receipts and pair IDs
pnpm eval:report --receipt <receipt.json> [--format table|markdown|json] [--checks]
pnpm eval:inspect --receipt <receipt.json> --pair <full-pair-id> --condition treatment --view session --export both
pnpm eval:export --receipt <receipt.json>                     # generate EVALS.md and EVALS-FULL-REPORT.md in the run folder
pnpm eval:export --check --all                                # fail if any run report is missing or stale, or any existing combined file is stale
pnpm eval:export --receipt <receipt.json> --to <dir|file.md> [--pair <pair-id|rNNN>]
pnpm eval --case <case-id> --skill <path_to_skill> --model <a> --model <b> [--repetitions N]   # one sealed run per model + runs/EVALS-<a>+<b>.md
pnpm eval:export --receipt <a.json> --receipt <b.json> [--check]           # combined EVALS.md of runs of one case
pnpm eval:recover --run <exact-run-id>                        # an interrupted run left containers or networks behind
```

## Before you finish a change

Run the checks that match what you touched:

| Change | Run |
| --- | --- |
| Any TypeScript | `pnpm typecheck:evals` and `pnpm test:evals` |
| `scripts/` | `pnpm test:evals` (`src/runner/run-cli.test.ts` spawns the entry points) and `pnpm eval:validate` |
| `src/core/` schemas, limits or rubric shape | `pnpm test:evals`, `pnpm eval:validate` and `pnpm eval:export --check --all`, so committed runs still load and render |
| A case's `validator.ts`, `rubric.json`, `oracle.json`, `fixture/` or `case.json` | `pnpm test:eval-cases` and `pnpm eval:validate` |
| Report or export rendering | `UPDATE_GOLDEN=1 pnpm test:evals` if the output change is intended (review the golden diff), then `pnpm eval:export --check --all`; regenerate stale reports with `pnpm eval:export --regenerate --all` |
| Guest runtime sources: `container/` and every file in the `sources` list of `scripts/build-guest-runtime.mjs` (parts of `src/core/`, `src/runner/models.ts`, `src/artifacts/native-prefix.ts`, `src/harnesses/pi/`) | `pnpm build:eval-guest`, then `node scripts/build-guest-runtime.mjs --check`; for Pi harness code also `pnpm test:eval-sdk` |
| Container or sandbox behavior | `pnpm test:container` (needs Apple Container) |
| Before pushing: mirror CI | `pnpm install --frozen-lockfile`, `node scripts/build-guest-runtime.mjs --check`, `pnpm typecheck`, `pnpm test` (vitest plus `test:eval-cases`), `pnpm eval:validate` and `pnpm eval:export --check --all` |

`container/guest-runtime/` is generated read-only output: rebuild it with `pnpm build:eval-guest`, never hand-edit it, and commit the regenerated files and `container/image-lock.json`. `pnpm eval:validate` with no arguments validates every case offline. Golden files live in `src/artifacts/__golden__/`.

## Conventions

- Colocate `*.test.ts` with the code under test.
- Tests must not depend on an external skills checkout or on provider credentials. Use `src/test-fixtures/skills/` and the fake harness and sandbox.
- Prefer small, typed, pure functions in `src/core/`. Keep side effects in `runner`, `sandboxes` and `artifacts`.
- Reports are rendered deterministically: no timestamps and no host paths.
- Use Conventional Commits with a one-line subject, ideally under 72 characters, and an optional body (for example `fix(evals): refuse export of ungraded pairs`). Merge commits are exempt.
- A new case goes under `eval-cases/<case-id>/` and should need no change to `core/`, harness, sandbox or provider code. Adding a provider, harness type, N-way variant, remote sandbox or LLM judge is a design change: ask first.

## Key behaviors

- **Budgets:** `wallClockMs`, `maxOutputTokens`, `maxToolSteps` and `maxProviderRequests` default to unlimited (`null`, also selected by `none` and `0`). A finite cap applies only when requested with `--limit <key>=<value>` (repeatable), and `wallClockMs` starts at each arm's own prompt. Resource bounds (`cpus`, `memoryMiB`, `pids`, `diskMiB`, export limits) are always finite and cannot be disabled.
- **Scheduling:** both arms always reach a readiness barrier before either is prompted. The CLI then runs them concurrently by default; `--serial` runs baseline first and verifies its cleanup before treatment is prompted, so the arms never overlap. At most one pair runs at a time, and its cleanup is verified before the next starts.
- **Candidate:** every arm is graded on its bounded final workspace.
- **Scoring:** each check belongs to `outcome` (sums to 80) or `constraints` (sums to 20); weights and the rubric version live in `src/runner/rubric.ts`. The runner scores centrally at seal time; any validator scalar is advisory. A full pass needs every check. Evidence without a frozen v0.2 rubric is legacy and is never reweighted.
- **Failures:** task failures are gradeable and may score 0. Infrastructure failures have `score: null`. The two are never mixed, and no delta is computed for a pair that is not gradeable.
- **Run exports:** after a verified run, `pnpm eval` writes the run-folder `EVALS.md` (the summary, the only file to share) and `EVALS-FULL-REPORT.md` (stays in this repo) next to `receipt.json`. A failed write only warns, and when the summary is refused only `EVALS-FULL-REPORT.md` is written. They are outside the hash chain, always recomputed from sealed evidence, and embed the run's `manifest.treeSha256`. Multi-pair runs report the mean over every pair (rounded only when rendered); `--pair` selects one. Export is refused if any rendered pair has an ungraded arm. After a renderer change, regenerate every report with `pnpm eval:export --regenerate --all`. `--to` writes the summary between `<!-- AF-EVAL:BEGIN/END generated -->` markers and preserves authored text outside them. The report link uses `--repo-url` or the `repository` field of `package.json`; the git remote is never read, and export runs no git commands.
- **Sessions:** sessions are sanitized native Pi sessions. Reasoning is stripped unless `--capture-reasoning` is set, in which case the session is private evidence. Files under `views/` are regenerable and outside the hash chain.

## Must not

- Do not weaken any guarantee below to make a test pass. If one cannot be met, stop and ask.

### Isolation and parity

- Do not break pair parity. The only difference between arms is the skill and the tools its frozen manifest declares; ambient evaluator tools go to both arms.
- Do not rely on ambient state, ambient credentials or ambient skill discovery (for example host `~/.pi`, global skills directories, or environment the runner does not pass).
- Do not put a skill, fixture, oracle, validator, test or answer in an image or build context.
- Do not share writable state between arms, repetitions or runs.
- Do not execute guest-authored code on the host.

### Evidence and results

- Do not edit, delete or regenerate anything under `eval-cases/*/runs/` except the two generated reports through `eval:export`, the generated combined `runs/EVALS-<a>+<b>.md` files (also through `eval:export`) and the regenerable, git-ignored `views/`. Everything else there is sealed.
- Do not mutate a built image identity, and do not create a `latest` pointer or a symlink into a run.
- Do not write a final receipt before every cleanup outcome is known.
- Do not re-run a task automatically to get a better result.
- Do not score an infrastructure failure as a task failure, and do not report a delta for an invalid pair.
- Do not present fake or test-double evidence as a measured result.
- Do not hand-edit `EVALS.md` or `EVALS-FULL-REPORT.md`. Change the generator and regenerate.

### Secrets

- Do not let a credential, or any scanned encoding of one, reach a file, log, hash, view or artifact. Never put keys in command arguments or committed files; `.env` is git-ignored.

### Scope

- Do not make an ordinary `eval` or `eval:report` modify the `EVALS.md` in a skill's own repository. (`eval` writes only the two generated files in its own run folder, plus the combined `runs/EVALS-<a>+<b>.md` for a multi-model command; `eval:report` writes nothing.)
- Do not add a published `bin`, `exports` or MCP surface to serve evals. This package is private.
- Do not decide rubric, scoring, badge, task-limit, variability or MCP questions on the owner's behalf.
- Do not reintroduce `--from` reproduction, ablation or determinism guarantees.
- Do not modify owner-authored case files to wire tests in.
- Do not commit local-only files (`*plan.md`, `.crew/`, `.state/`, `.pi/`, `docs/ARCHITECTURE.md`, `.env`). Never force-add ignored files.

## Project knowledge (maintained by /crew)

### Architecture

- Human documentation is the root `README.md` plus flow-based files in `docs/` (`how-it-works.md`, `running-evals.md`, `create-an-eval-case.md`, `contributing.md`). There is no `docs/README.md`: the root README is the only router (its header nav and callout), so a new guide gets a nav link there.

### Specification constraints

- The root `README.md` holds only the header, a short purpose intro, "What is an eval?", "Requirements" and "Quickstart", and those sections do not link into `docs/`. Other material belongs in the `docs/` file for its reader.
- The project name in prose is "Evals Guidelines". The `package.json` name and the repository name are unchanged.
- Sandbox descriptions must not call the agent guest an offline sandbox: it has public IPv4 egress (`container/configure-egress.sh`).

### Decisions from accepted work

- `docs/` is tracked; only `docs/ARCHITECTURE.md` stays git-ignored (`.gitignore`), so the owner's local contract is never committed.
- `EVALS.md` is a skill-centred document in the owner's V2 layout (2026-11-08): `# <skill> — Evaluation cases`; Case index one row per (case, model) with Score `<treatment> (<change>)`; per case `## <case-id>`, Task once, Results one row per model with `Baseline → Treatment<br>change` cells, `### Outcome Checks · <case-id>` one column per model (`B → T`, a single value when equal); Full reports one row per (case, model) linking that model's own run `EVALS-FULL-REPORT.md` (also in a combined summary). It is rendered by a pure `renderScoredSummaryMarkdown(SummaryDocument)` from entries built in `src/artifacts/summary-entry.ts`; both `run-exports.ts` and `publish.ts` go through `renderSummaryForReport`. Its manifest tree hash lives in a hidden `<!-- EVALS-ENTRY … -->` comment (never the `AF-EVAL:` prefix, which `publish.ts` rejects). Readable model names come from `src/artifacts/model-label.ts`, not the guest-runtime `src/runner/models.ts`.
- `EVALS-FULL-REPORT.md` is one case/run, results first (Results, Pair explorer with every recorded pair in `<details>`, Task and rubric, Execution environment, Verify this report, Export and comparable runs), rendered by the pure `src/artifacts/full-report.ts` from input built in `full-report-input.ts`. It carries no operational/runtime dump; that stays in `eval:report --details` and `eval:inspect` (`renderPairDetails`). Partial-grading notes are presentation-only; the per-arm mean policy in `scored-report.ts` is unchanged.
- `network-config-01` (case version 11) scores its `rpc-endpoints` topic with two independent cross-environment checks (owner decision, 2026-11-06): `rpc-routing` (5: read RPC and `sequencerSubmissionUrl` correct in both environments, each `writeRpcUrl` that network's public RPC or its own sequencer) and `write-rpc-provider` (5: the public RPC as `writeRpcUrl` in both), so using that network's own sequencer as the write URL earns exactly 5/10 (another network's sequencer fails both checks). Committed v10 runs keep their frozen per-environment checks. Besides `validator.test.ts`, `src/runner/rubric.test.ts`, `src/runner/run.test.ts` and the `evals-full-report.mean.md` golden render or pin the live case, so a version or check-ID change updates them too.
- A run export reads and verifies the run's frozen inputs once and passes them to both renderers (`src/artifacts/run-exports.ts`). The full-report adapter receives the bare summary-refusal reason; only `RunExports.summaryRefusal` adds "; EVALS.md is not generated".
- No generated report renders a status badge (owner decision): the shields.io `AF-Evaluation` badge and its generator were removed from the summary, full report and `eval:report` Markdown. Badges in sealed `inputs/frozen/` files are evidence and stay as recorded.
- A multi-model command (`pnpm eval … --model A --model B`, owner decisions 2026-11-08) runs each model as its own independent sealed run, sequentially in argument order, so the target stays a per-run parity field; there is no batch concept (no `inputs/batch.json`, no `batches/`; the sealed `inputs/batch.json` in older runs is opaque evidence nothing decodes). Sequencing, stop classification, signals and exit code live in `src/runner/batch.ts` (`runBatchSequence`, `batchStopReason`); a run stops the sequence on a signal, a run that did not start, verification failure, unverified or failed cleanup, quarantine or an escaping exception, and otherwise the sequence continues; exit 0 only if every planned run completed and verified. After the loop, and for `eval:export --receipt a --receipt b`, `src/artifacts/combined-exports.ts` verifies the runs, builds each run's `SummaryEntry` and renders one V2 `EVALS.md` with the shared renderer, written as the file `eval-cases/<case>/runs/EVALS-<runA>+<runB>[+…].md` (ids in argument order); `pnpm eval` prints its path. There is no combined full report: Full reports link each run's own report. The combined file is refused (nothing written) for fewer than two or duplicate runs, runs of different cases, differing skill tree hash, case version, rubric version or prompt hash, any refused member summary (ungraded pair), or differing check lists. `eval:export --check --all` (`checkAllCombined`) parses members strictly from every `runs/EVALS-*.md` name and fails on a missing member, a refused combination, an unparseable name or a stale file; `--regenerate --all` (`regenerateAllCombined`) rewrites them and removes a now-refused one. With no registry, a deleted combined file is invisible to `--all`; only `eval:export --receipt a --receipt b --check` reports it missing (and the same command without `--check` recreates it). Two members with the same readable model label are refused. history and recover only walk directories in `runs/`, so the file is invisible to them.
- After the guest's `result` frame the host waits up to 10 s for the guest SDK process to exit (`REMOTE_CLOSE_TIMEOUT_MS`, `src/harnesses/pi/adapter.ts`; host-only, not a guest-runtime source). Measured closes after a wall-clock abort reach ~1.5 s, so 2 s produced spurious `protocol-drift` infrastructure failures; a guest that never exits still fails with `protocol-drift`.
- `eval-cases/README.md` is only a pointer; the case-author, operator and concept material lives in `docs/create-an-eval-case.md`, `docs/running-evals.md` and `docs/how-it-works.md`. Update those files, not the pointer, when the case format or CLI changes.
