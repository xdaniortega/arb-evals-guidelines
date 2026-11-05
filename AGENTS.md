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
pnpm eval:export --check --all                                # fail if any generated report is missing or stale
pnpm eval:export --receipt <receipt.json> --to <dir|file.md> [--pair <pair-id|rNNN>]
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

- Do not edit, delete or regenerate anything under `eval-cases/*/runs/` except the two generated reports through `eval:export` and the regenerable, git-ignored `views/`. Everything else there is sealed.
- Do not mutate a built image identity, and do not create a `latest` pointer or a symlink into a run.
- Do not write a final receipt before every cleanup outcome is known.
- Do not re-run a task automatically to get a better result.
- Do not score an infrastructure failure as a task failure, and do not report a delta for an invalid pair.
- Do not present fake or test-double evidence as a measured result.
- Do not hand-edit `EVALS.md` or `EVALS-FULL-REPORT.md`. Change the generator and regenerate.

### Secrets

- Do not let a credential, or any scanned encoding of one, reach a file, log, hash, view or artifact. Never put keys in command arguments or committed files; `.env` is git-ignored.

### Scope

- Do not make an ordinary `eval` or `eval:report` modify the `EVALS.md` in a skill's own repository. (`eval` writes only the two generated files in its own run folder; `eval:report` writes nothing.)
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
- `eval-cases/README.md` is only a pointer; the case-author, operator and concept material lives in `docs/create-an-eval-case.md`, `docs/running-evals.md` and `docs/how-it-works.md`. Update those files, not the pointer, when the case format or CLI changes.
