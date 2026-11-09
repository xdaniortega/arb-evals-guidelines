# Running evals

How to run an eval, read the result, dig into a run and export its reports.

## Options for `pnpm eval`

| Option | What it does |
|---|---|
| `--case <id>` | The case to run. Required. |
| `--skill <path>` | The treatment's skill: any directory with a `SKILL.md` (no symlinks or URLs). The evidence records the skill's name, never your local path. Required. |
| `--model <id>` | The model to call; the provider is inferred from the id. Required. Repeat it to compare models (see below). |
| `--provider <google\|anthropic>` | Sets the provider when the model id is ambiguous. |
| `--thinking <level>` | Reasoning effort: `off`, `minimal`, `low` (default), `medium`, `high`, `xhigh` or `max`. |
| `--repetitions <n>` | Number of pairs. Default `1`. |
| `--limit <key>=<value>` | Caps one budget; repeatable. `wallClockMs`, `maxOutputTokens`, `maxToolSteps` and `maxProviderRequests` are unlimited by default (`0` or `none` keeps them unlimited). Resource limits such as `cpus` or `memoryMiB` can be changed but not removed. |
| `--serial` | Runs the baseline first and the treatment only after it, so the arms never overlap. By default they run side by side. |
| `--checks` | Adds the per-check table to the printed result. |
| `--capture-reasoning` | Keeps the model's reasoning in the saved session. Off by default, because it makes sessions much larger. |

### Several models in one command

Repeat `--model` to evaluate the same skill with several models:

```bash
pnpm eval -- --case network-config-01 --skill <path> \
  --model gemini-3.8-flash --model gemini-4-argon --limit wallClockMs=300000
```

Each model gets its own independent sealed run, in the order you list them, with its own `EVALS.md` and `EVALS-FULL-REPORT.md`. The other options apply to every model. At the end, the command prints the path of one combined `EVALS.md` with a row per model, `eval-cases/<case>/runs/EVALS-<run-id-A>+<run-id-B>.md`. There's no combined full report: it links each run's own.

- **Nothing is re-run.** If a run doesn't start, can't be verified, fails its cleanup or quarantines a secret, or you stop the command, the remaining models are skipped and listed. The command exits 0 only if every run completed and verified.
- **The combined file needs comparable runs.** It's skipped, with a warning, if a model didn't run, a run doesn't verify or has no pair graded in both arms, or the runs differ in case version, rubric version, prompt or skill.
- **Models run one after another**, so time of day and provider load can differ between them.

To combine runs you already have, see [Combine existing runs](#combine-existing-runs).

## Read the output

A run prints a header and the pillar table, then the Accuracy and Cost and latency tables, and ends with the commands to inspect and export it. For example (illustrative values):

```text
network configuration migration
Agent:  Pi · google/gemini-3.8-flash
Skill:  arbitrum-docs
Run:    20261002T101500Z-3f9a1c2d · Pair r001
Status: Without this skill: task limit reached, graded · With this skill: completed, graded

Evaluation pillars:
┌───────────────────────┬────────────────────┬─────────────────┬───────────────────────┐
│ Pillar                │ Without this skill │ With this skill │                Change │
├───────────────────────┼────────────────────┼─────────────────┼───────────────────────┤
│ Accuracy              │                30% │             85% │ +55 percentage points │
│ Cost: recorded tokens │          2,106,273 │         921,312 │   −1,184,961 (−56.3%) │
│ Latency               │         300,155 ms │       89,975 ms │  −210,180 ms (−70.0%) │
└───────────────────────┴────────────────────┴─────────────────┴───────────────────────┘
```

- `--checks` (on `eval` or `eval:report`) adds the **Accuracy Outcome Checks** table: one row per topic and an **Outcome total**.
- `n/a` means the arm has no grading evidence. Latency marked `(session-derived)` was rebuilt from the agent's session because the recorded duration was missing, and changes based on it are marked `approximate`.
- For a complete real report, see [this run's EVALS-FULL-REPORT.md](../eval-cases/network-config-01/runs/20261108T093450Z-392b231d/EVALS-FULL-REPORT.md).

## Inspect a run

Inspecting only reads the saved evidence; it never calls the model. Every command has the same shape:

```bash
pnpm eval:inspect -- --latest --case <case-id> --condition <baseline|treatment> --view <name>
```

To look at a specific run instead of the latest, replace `--latest --case <case-id>` with `--receipt "<receipt-path>"`.

### Step 1: find your run

```bash
pnpm eval:history -- --latest --case network-config-01
```

This prints the receipt path and pair ids of your latest run. With several repetitions, add `--pair <pair-id>` to the commands below.

### Step 2: open the session

The **session** is the agent's transcript: every message, tool call and tool result, in order.

```bash
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view session --export both
```

This prints the path of a `.jsonl` file (Pi's native session) and an `.html` file. **Open the HTML in a browser**, then repeat with `--condition baseline` to compare. Guarded secrets show up as `[REDACTED:<label>]`.

> **Private evidence.** With `--capture-reasoning`, sessions keep the model's reasoning word for word. They stay in the local run folder and the runner never uploads them; don't publish session exports.

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

## Export: `EVALS.md` and `EVALS-FULL-REPORT.md`

Every verified run writes two reports next to its `receipt.json`:

| File | What's in it | Share it? |
|---|---|---|
| `EVALS.md` | The summary, titled `# <skill> — Evaluation cases`. For each case and model: the task, the results (score, tokens and latency as `Baseline → Treatment` with the change), the outcome checks and a link to the full report. | **Yes, it's the only file to share.** |
| `EVALS-FULL-REPORT.md` | Everything about one run, results first: every pair, the task and rubric, the execution environment and how to verify the report. | No, it stays in this repository and `EVALS.md` links to it. |

The score change is a plain difference in percentage points: going from 20% to 69% shows as `+49%`.

```bash
pnpm eval:export -- --receipt <receipt>                                   # (re)generate both files in the run folder
pnpm eval:export -- --receipt <receipt> --to <dir|file.md> [--pair rNNN]  # also write EVALS.md somewhere else
pnpm eval:export -- --check --all                                         # fail if any report is missing or stale (CI)
```

- **Built from evidence, every time.** Export verifies the run first and writes nothing if that fails. The reports sit outside the hash chain but carry the run's tree hash (`manifest.treeSha256`), so you can trace them back to it. In `EVALS.md` it's in a hidden `<!-- EVALS-ENTRY … -->` comment.
- **Like-for-like means.** With several pairs, `EVALS.md` only uses the pairs graded in both arms, for both arms and every metric. A left-out pair is named in the Results note. Export is refused if no pair qualifies, or if `--pair` picks one that doesn't. `EVALS-FULL-REPORT.md` still shows every pair, so its means can differ for a partial run.
- **`--to` keeps your text.** The summary goes between `<!-- AF-EVAL:BEGIN generated -->` and `<!-- AF-EVAL:END generated -->`, and anything outside those markers is kept.
- **Merge here first.** The full-report link points at this repository (`--repo-url` or `repository` in `package.json`), so merge this repository's PR before the skill repository's.
- `pnpm eval` and `eval:report` never change a skill's own `EVALS.md`.

### Combine existing runs

To build a combined `EVALS.md` from runs you already have, pass their receipts in the order you want:

```bash
pnpm eval:export -- --receipt <receipt-A> --receipt <receipt-B>           # write runs/EVALS-<A>+<B>.md
pnpm eval:export -- --receipt <receipt-A> --receipt <receipt-B> --check   # fail if it's missing, stale or refused
```

The runs must be different runs of the same case, with different models but the same skill, case version, rubric version and prompt, and each needs at least one pair graded in both arms. Otherwise nothing is written.

Combined files are generated, never sealed. `--check --all` checks every one that exists and `--regenerate --all` rebuilds them, but nothing records which combinations should exist, so a deleted file is only noticed by the `--receipt … --check` command above.
