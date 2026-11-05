# Eval cases

This folder holds every eval case and its sealed run evidence. This guide explains what a case is, how it is scored, how to run it with your skill, how to export the results and how the evidence is kept. To run an existing case for the first time, start with the [Quickstart](../README.md#quickstart) in the root README. To submit a case, see [How to submit your eval case](../docs/create-an-eval-case.md#how-to-submit-your-eval-case). Each section below ends with a link to the guide in [`docs/`](../docs/) that explains it further.

## 1. What is an eval case?

An eval case is **one task with a deterministic way to grade it**. It lives in its own folder, `eval-cases/<case-id>/`, and the folder name equals the case id. Adding a case needs no change to `src/`.

A case is not tied to a skill. You choose the skill at run time with `--skill`, so the same case can measure different skills, or different versions of one skill.

For each pair, the runner uses the case like this:

1. **Both arms get the same task.** The prompt from `case.json` and a fresh copy of `fixture/` go to the baseline and the treatment. The only difference is that the treatment also has the frozen skill.
2. **The agent works in its workspace** and leaves its answer at the `outputPath` declared in `case.json`.
3. **The final workspace is graded.** `validator.ts` runs in a separate offline container with no credentials and compares the answer to `oracle.json`. The agent never sees the oracle, the validator or the rubric.
4. **The runner scores centrally** from the frozen `rubric.json` and the result of each check, and seals everything into the run folder.

A good case has an answer that can be checked by code, has a known correct result with sources, and is one where a skill could plausibly make a difference.

> Further explanation: [What is an eval case?](../docs/create-an-eval-case.md#what-is-an-eval-case) in Create an eval case.

## 2. Scoring rubric

The guidelines standardize how we score; each case defines what a correct outcome means.

| Pillar | Measured as |
|---|---|
| Accuracy | Points out of 100 from the case's checks. **Outcome** (80): did the agent correctly and fully deliver what was asked, including the expected response to any predefined failure or invalid input? **Constraints** (20): did it respect the task boundaries and preserve what must not change? |
| Cost | Recorded tokens, including cached input. |
| Latency | Milliseconds from the arm's prompt to completion or termination. |

Each pillar is reported as a baseline → treatment change; with several pairs, as the mean over the pairs.

Declare the checks in `rubric.json` and implement them in `validator.ts`:

- **One entry per check** in `rubric.json`: `id`, `group` (`outcome` or `constraints`), display `topic` and `points`. `outcome` checks sum to 80 and `constraints` checks to 20. Checks with the same `topic` are shown together in the **Accuracy Outcome Checks** table.
- **One deterministic predicate per check** in `validator.ts`. The same answer and the same oracle always give the same result. No language model judges the answer.
- **All or nothing.** Each check earns its full points or 0, and a full pass needs every check.
- **The runner decides the score.** Any score the validator computes is advisory; the runner recomputes it from the frozen rubric.
- **Task failures and infrastructure failures are kept apart.** If the agent fails the task, the arm is still graded and may score 0. If the infrastructure fails, the arm has no score, and no change is reported for that pair.
- **Test your validator.** `validator.test.ts` must show that wrong answers fail and that accepted variants pass.

> Further explanation: [Scoring rubric](../docs/how-it-works.md#scoring-rubric) in How it works.

## 3. Case layout

Use `network-config-01` as a template:

```text
eval-cases/
└── network-config-01/
    ├── README.md            # Optional case documentation (see below)
    ├── case.json            # Task prompt, output path and allowed tools
    ├── fixture/             # Agent workspace: the starting files both arms receive
    ├── oracle.json          # Hidden golden answers and their sources; never shown to the agent
    ├── rubric.json          # Checks and weights (rubric v0.2)
    ├── validator.ts         # Scores the final workspace against the oracle, in a separate container
    ├── validator.test.ts    # Wrong-answer and accepted-variant tests
    └── runs/                # Sealed evidence and generated reports (views/ is git-ignored)
```

**Case `README.md` (optional).** Documentation only, not evidence; no tool reads it. Use the same sections in every case: Why this case exists · The task · How to run it · Scoring rubric (one row per check) · Provenance · Additional context (optional) · Results. See the [network-config-01 README](network-config-01/README.md).

> Further explanation: [Case layout](../docs/create-an-eval-case.md#case-layout) in Create an eval case.

## 4. Run your eval with your skill

There is no import step: `--skill` takes any directory containing `SKILL.md` (no symlinks, no URLs). The runner freezes and hashes a copy into `runs/<run-id>/inputs/frozen/skill/`; never edit it.

```bash
pnpm test:eval-cases                                                # validator tests
pnpm eval:validate -- --case <case-id> --skill <path_to_skill>      # offline input check
pnpm eval:doctor -- --model <model-id>                              # readiness; no completion requests
pnpm eval -- --case <case-id> --skill <path_to_skill> --model <model-id> [--repetitions N]
```

A verified run writes `EVALS.md` and `EVALS-FULL-REPORT.md` into its run folder (see [Export](#6-export-evalsmd-and-evals-full-reportmd)). For every `pnpm eval` option and for inspecting a run, see [Inspect a run](#5-inspect-a-run).

> Further explanation: [Run your eval with your skill](../docs/create-an-eval-case.md#run-your-eval-with-your-skill) in Create an eval case.

## 5. Inspect a run

Inspection reads saved evidence and sends no model requests. Commands follow one shape: `pnpm eval:inspect -- --latest --case <case-id> --condition <baseline|treatment> --view <name>`. To pin a specific run, replace `--latest --case <case-id>` with `--receipt "<receipt-path>"`.

### Step 1: find your run

```bash
pnpm eval:history -- --latest --case network-config-01
```

This prints the receipt path and pair ids of your latest run. With several repetitions, pass `--pair <pair-id>` to the commands below.

### Step 2: open the session

The **session** is the agent's transcript: every message, tool call and tool result, in order.

```bash
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view session --export both
```

This prints a `.jsonl` path (Pi's native session) and an `.html` path. **Open the HTML in a browser.** Guarded secrets appear as `[REDACTED:<label>]`. Repeat with `--condition baseline` and compare.

> **Private evidence.** With `--capture-reasoning`, sessions keep the model's reasoning verbatim. They stay in the local run folder and are never uploaded by the runner; do not publish session exports.

### Step 3: check the result

```bash
pnpm eval:inspect -- --latest --case network-config-01 --condition treatment --view candidate    # final answer
pnpm eval:inspect -- --latest --case network-config-01 --condition treatment --view validation   # each check and why
pnpm eval:report  -- --receipt "<receipt-path>" --checks                                          # the saved comparison
```

### Other views

| `--view` | Shows |
|---|---|
| `session` | The full transcript (see Step 2). |
| `messages` | Only the message text. |
| `tools` | Only the tool calls and results. |
| `candidate` | The final answer the validator scored. |
| `validation` | Per-check pass/fail and the score. |
| `workspace` | The files the agent left behind. |
| `condition` | Status, timing and usage for one arm. |
| `errors` | What went wrong in a failed arm. |
| `runtime` | The model, provider and thinking level actually used. |
| `attestation` | The guest policy (tools, network, skill) the arm ran under. |
| `redactions` | How many secrets were redacted, and where. |

### Options for `pnpm eval`

| Option | What it does |
|---|---|
| `--case <id>` | Case to run. Required. |
| `--skill <path>` | Treatment skill: any directory containing `SKILL.md` (no symlinks, no URLs). Evidence records only the skill name, never the host path. The baseline gets none. Required. |
| `--model <id>` | Model to call. Required. The provider is inferred from the id. |
| `--provider <google\|anthropic>` | Asserts the provider when the model id is ambiguous. |
| `--thinking <level>` | Reasoning effort: `off`, `minimal`, `low` (default), `medium`, `high`, `xhigh`, `max`. |
| `--repetitions <n>` | Number of pairs. Default `1`. |
| `--capture-reasoning` | Keeps reasoning in the saved session. Off by default (much larger sessions). |
| `--limit <key>=<value>` | Overrides one budget; repeatable. `wallClockMs`, `maxOutputTokens`, `maxToolSteps`, `maxProviderRequests` take a positive integer or `0`/`none` (unlimited, the default). Resource bounds (`cpus`, `memoryMiB`, `pids`, `diskMiB`, …) stay finite. |

> Further explanation: [Inspect a run](../docs/running-evals.md#inspect-a-run) and [Options for `pnpm eval`](../docs/running-evals.md#options-for-pnpm-eval) in Running evals.

## 6. Export: `EVALS.md` and `EVALS-FULL-REPORT.md`

Each run folder holds two generated files next to `receipt.json`:

- **`EVALS.md`**: the summary (header with the run hash, badge, pillar table, scenario and **Accuracy Outcome Checks**). **The only file to share.**
- **`EVALS-FULL-REPORT.md`**: the complete report (case description, all tables, per-pair results, verification, operational details, reproducibility). It stays in this repository; `EVALS.md` links to it.

```bash
pnpm eval:export -- --receipt <receipt>                                   # (re)generate both files in the run folder
pnpm eval:export -- --receipt <receipt> --to <dir|file.md> [--pair rNNN]  # also write EVALS.md elsewhere
pnpm eval:export -- --check --all                                         # fail if any file is missing or stale (CI)
```

- Evidence is verified first; nothing is written if verification fails. Export runs no git commands.
- Both files are outside the hash chain, regenerated from sealed evidence, and carry the run's `manifest.treeSha256`.
- Without `--pair`, a multi-pair run exports the mean over every pair. Export is refused if any rendered pair has an ungraded arm.
- With `--to`, the summary goes between `<!-- AF-EVAL:BEGIN generated -->` and `<!-- AF-EVAL:END generated -->`; authored text outside the markers is kept, and repeating the export changes no bytes. Symlinked destinations are refused.
- The full-report link uses `--repo-url` or the `repository` field of `package.json`. It resolves once the run folder is merged, so merge this repository's PR before the skills repository's.
- `pnpm eval` and `eval:report` never modify a skill's `EVALS.md`.

> Further explanation: [Export](../docs/running-evals.md#export-evalsmd-and-evals-full-reportmd) in Running evals.

## 7. Evidence and cleanup

Evidence is sealed in `eval-cases/<case-id>/runs/<run-id>/` and committed. A receipt and manifest hash the retained files; `eval:report` and `eval:inspect` verify that chain, so editing a sealed file breaks verification. `views/` (git-ignored) and the two generated reports are outside the chain.

If an interrupted run leaves containers or networks behind: `pnpm eval:recover -- --run <run-id>`.

> Further explanation: [Evidence and cleanup](../docs/how-it-works.md#evidence-and-cleanup) and the [Sandboxed environment](../docs/how-it-works.md#sandboxed-environment) in How it works.

## 8. Project layout

```text
README.md  AGENTS.md                 # Human guide, agent guide
package.json  pnpm-lock.yaml         # Scripts and dependencies
tsconfig.json  vitest.config.ts      # TypeScript and unit-test configuration
.env.example                         # Credential template; copy locally to .env
.github/workflows/ci.yml             # Lock check, typecheck, tests, offline case validation, export freshness
container/                           # Guest image, network setup, locked runtime and image lock
scripts/                             # Command-line entrypoints and the guest runtime build
src/
├── core/                            # Schemas, comparison rules, limits and redaction
├── runner/                          # Setup, case loading and paired-run orchestration
├── harnesses/                       # Agent execution through Pi or test doubles
├── sandboxes/                       # Container lifecycle and test doubles
├── artifacts/                       # Saved evidence, verification, reports and exports
└── test-fixtures/skills/            # Synthetic skills used only by tests
eval-cases/<case-id>/                # One folder per case (see 3)
```

> Further explanation: [Project layout](../docs/contributing.md#project-layout) in Contributing.
