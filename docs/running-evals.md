# Running evals

How to run an eval, read its output, inspect a run and export its reports.

## Options for `pnpm eval`

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
- For a complete real report, see [this run's EVALS-FULL-REPORT.md](../eval-cases/network-config-01/runs/20260924T170734Z-b115674e/EVALS-FULL-REPORT.md).

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
