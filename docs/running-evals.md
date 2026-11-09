# Running evals

How to run an eval, read its output, inspect a run and export its reports.

## Options for `pnpm eval`

| Option | What it does |
|---|---|
| `--case <id>` | Case to run. Required. |
| `--skill <path>` | Treatment skill: any directory containing `SKILL.md` (no symlinks, no URLs). Evidence records only the skill name, never the host path. The baseline gets none. Required. |
| `--model <id>` | Model to call. Required. The provider is inferred from the id. Repeat it to evaluate several models in one command (see below). |
| `--provider <google\|anthropic>` | Asserts the provider when the model id is ambiguous. |
| `--thinking <level>` | Reasoning effort: `off`, `minimal`, `low` (default), `medium`, `high`, `xhigh`, `max`. |
| `--repetitions <n>` | Number of pairs. Default `1`. |
| `--capture-reasoning` | Keeps reasoning in the saved session. Off by default (much larger sessions). |
| `--limit <key>=<value>` | Overrides one budget; repeatable. `wallClockMs`, `maxOutputTokens`, `maxToolSteps`, `maxProviderRequests` take a positive integer or `0`/`none` (unlimited, the default). Resource bounds (`cpus`, `memoryMiB`, `pids`, `diskMiB`, …) stay finite. |

### Several models in one command

`pnpm eval --case <id> --skill <path> --model gemini-3.8-flash --model gemini-4-argon --limit wallClockMs=300000` runs each model as its own independent, sealed run, one after another in argument order, each with its own `EVALS.md` and `EVALS-FULL-REPORT.md` exactly as for a single model. `--provider`, `--thinking`, `--limit` and `--repetitions` apply to every model. Duplicate models and `--format json` with more than one model are refused before anything runs.

The runs are independent: nothing is sealed to tie them together. When the command ends, it prints `combined  eval-cases/<case>/runs/EVALS-<run-id-A>+<run-id-B>.md`, a combined `EVALS.md` built from those verified runs (run ids in argument order, joined by `+`; there is no combined full report). It has one row per model in the Case index, Results and Full reports tables, one column per model in Outcome Checks, and links each model's own run `EVALS-FULL-REPORT.md`. It is not generated (a warning says why) if a model did not run, a run's evidence does not verify, or a run has no pair graded in both arms (a run with some ungraded pairs is still combined, over its graded pairs); it is also refused if the runs differ in case version, rubric version, prompt or skill. A signal (a second signal during startup or between runs force-exits; during a run the runner's own handlers seal the run), a run that did not start or threw, a failed evidence verification, an unverified or failed cleanup, or a secret quarantine stops the command (models not started are listed); nothing is re-run. The command exits 0 only if every planned run completed and verified; it exits 1 if any run failed to complete or verify, any model did not run, or the command stopped. Models run sequentially, so time of day and provider load can drift between them.

You can also combine any existing runs of one case yourself, in the order you give them:

```bash
pnpm eval:export -- --receipt <receipt-A> --receipt <receipt-B> [--receipt ...]           # write eval-cases/<case>/runs/EVALS-<A>+<B>.md
pnpm eval:export -- --receipt <receipt-A> --receipt <receipt-B> --check                   # fail if it is missing, stale or refused (the only way to notice a deleted file)
```

The runs must be distinct runs of the same case, with the same skill, case version, rubric version and prompt, and at least one pair graded in both arms in each run (pairs with an ungraded arm are left out of that run's metrics, as in a single-run `EVALS.md`); otherwise the command exits 1 and writes nothing. `--pair`, `--to` and `--all` cannot be combined with several `--receipt`. The combined file is a generated output, rebuilt from the sealed runs named in its file name, and is never part of a hash chain. `pnpm eval:export -- --check --all` checks every combined `eval-cases/*/runs/EVALS-*.md` that exists: it fails on a name that is not `EVALS-<run-id>+<run-id>[+...].md` with distinct run ids, a member run that is missing, a combination that is now refused, or a file that differs from a fresh render. `pnpm eval:export -- --regenerate --all` rewrites each existing combined file from its members and removes one whose combination is now refused (it says so); a file with a missing member or an unparseable name fails and is left alone. Nothing records which combinations should exist, so a combined file that was deleted is not noticed by `--all`: `pnpm eval:export -- --receipt <A> --receipt <B> --check` reports it as missing, and the same command without `--check` recreates it. The runs must also have different readable model labels, and the file name (run ids joined by `+`) must fit in a file name; otherwise the combination is refused.

## Read the output

A single-pair run prints a header and the pillar table, then the Accuracy and Cost and latency tables and a footer with the receipt, inspect and export commands. Example (illustrative values):

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

- `--checks` (on `eval` or `eval:report`) adds the **Accuracy Outcome Checks** table: one row per display topic, with an **Outcome total**.
- An arm without grading evidence shows `n/a` for accuracy. If its recorded duration is missing, latency comes from the native session, labelled `(session-derived)`, and changes using it are labelled `approximate`.
- For a complete real report, see [this run's EVALS-FULL-REPORT.md](../eval-cases/network-config-01/runs/20261108T093450Z-392b231d/EVALS-FULL-REPORT.md).

## Inspect a run

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

## Export: `EVALS.md` and `EVALS-FULL-REPORT.md`

Each run folder holds two generated files next to `receipt.json`:

- **`EVALS.md`**: the summary, titled `# <skill name> — Evaluation cases`: a **Case index** (one row per case and model; Score is the Treatment score with the change from Baseline in parentheses, for example `90% (+70%)`), then for each evaluated case its **Task** (shown once, even for several models), a **Results** table (one row per model; Score, recorded tokens and latency, each cell as `Baseline → Treatment` with the change below) and **Outcome Checks · `<case-id>`** (one row per check and a final total, one column per model; a cell shows `Baseline → Treatment` points, or a single value when both arms scored the same), and a final **Full reports** table with one link per case and model to that model's own run report. Score is the accuracy result, and its change is the arithmetic difference of the two scores (20% to 69% is `+49%`). There is no badge or run header. **The only file to share.**
- **`EVALS-FULL-REPORT.md`**: the report of one case and run, results first. It opens with a run context table (case, run, skill, agent, LLM model and every recorded pair), then has six sections: **Results** (Score, recorded tokens and latency for Baseline and Treatment with the change, then Execution status, Score composition, Outcome Checks and Cost and latency detail), **Pair explorer** (an index of every recorded pair, each linking to a collapsible block with that pair's status, Score composition, Outcome Checks and cost and latency, also for a single pair), **Task and rubric** (the frozen prompt, case definition and frozen checks and weights), **Execution environment** (readable and registered model, source, build, image digests, skill hashes, limits and elapsed time), **Verify this report** (the manifest tree hash and the receipt manifest file hash, and the verification command) and **Export and comparable runs**. The change in Score is the arithmetic difference in percentage points. If grading is incomplete the report says so, shows `n/a` for the missing cells and does not compute a Score change. Legacy runs keep their original recorded scores and are not reweighted. It does not contain the per-execution operational record (requests, tool steps, stop causes, cleanup, redactions); `pnpm eval:report --details` and `eval:inspect` still show those. It stays in this repository; `EVALS.md` links to it (for a combined file, to each model's own run report).

```bash
pnpm eval:export -- --receipt <receipt>                                   # (re)generate both files in the run folder
pnpm eval:export -- --receipt <receipt> --to <dir|file.md> [--pair rNNN]  # also write EVALS.md elsewhere
pnpm eval:export -- --check --all                                         # fail if any run, or any existing combined file, is missing or stale (CI)
```

- Evidence is verified first; nothing is written if verification fails. Export runs no git commands.
- Both files are outside the hash chain, regenerated from sealed evidence, and carry the run's `manifest.treeSha256`. The full report shows it in its "Verify this report" section. `EVALS.md` keeps it out of sight in an `<!-- EVALS-ENTRY ... treeSha256=<hash> -->` HTML comment at the end of the summary (inside the generated block), bound to that entry's case, run and rendered pairs; view the raw file to read it.
- Without `--pair`, a multi-pair run exports the mean over the pairs graded in both arms, and every metric (score, tokens, latency, outcome points) uses only those pairs, the same set for both arms. When a pair is left out, the Results note says so (for example `Metrics are means across nine of ten pairs; pair r010 is excluded because its baseline arm was not graded.`) and the hidden `EVALS-ENTRY` comment lists only the included pairs. Export is refused if no pair is graded in both arms, or if `--pair` selects a pair with an ungraded arm. `EVALS-FULL-REPORT.md` still shows every recorded pair.
- With `--to`, the summary goes between `<!-- AF-EVAL:BEGIN generated -->` and `<!-- AF-EVAL:END generated -->`; authored text outside the markers is kept, and repeating the export changes no bytes. Symlinked destinations are refused.
- The full-report link uses `--repo-url` or the `repository` field of `package.json`. It resolves once the run folder is merged, so merge this repository's PR before the skills repository's.
- `pnpm eval` and `eval:report` never modify a skill's `EVALS.md`.
