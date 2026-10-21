# Evals Guidelines


Does a skill help an agent do a task better? The Arbitrum evals guidelines compare the same agent **with and without a selected skill**, check its work, and keep the evidence so you can inspect the result.

Start with one pair to understand the workflow. Repeat the comparison to learn whether an improvement is consistent.

The skill under test can be any directory containing `SKILL.md`, anywhere on disk. This repository holds the runner, the eval cases and the sealed run evidence. You pass the path of one skill directory to `--skill`.

## 1. What is an eval?

An evaluation, or **eval**, is a task with a defined way to judge the answer. Here, each comparison runs that task twice:

1. **Baseline:** the agent has no evaluated skill available.
2. **Treatment:** the same agent has a frozen, unchanged copy of the selected skill available.

Each attempt is called an **arm**. A baseline and treatment together form a **pair**. One command invocation is a **run**, which can contain one or several pairs.

The agent receives a prompt and starting files, does the task, and leaves its answer in the workspace. A **validator** then checks that answer against expected results and assigns a score. An **oracle** is the case's reference data: the expected answers and their sources. It stays hidden from the agent.

### What does “deterministic” mean here?

The checks are deterministic: **the same captured answer and frozen grading inputs produce the same score**. Another language model does not decide whether the answer looks good.

The agent's answers can still vary between attempts. Deterministic grading gives us a consistent measuring tool; it does not guarantee that the skill improves every answer. Repeated pairs help us see how consistent the observed difference is.

## Requirements

For a measured evaluation, you need:

- **Apple-silicon macOS**, with Apple Container installed and running. Check with `container system status`.
- **Node.js 24.21.0**, the selected evaluation baseline, and **pnpm 10.33.2**.
- This repository and its dependencies, installed with `pnpm install --frozen-lockfile`.
- A skill directory containing `SKILL.md`, anywhere on disk (for an existing run, its frozen copy under `runs/<run-id>/inputs/frozen/skill/`; see 2.2).
- An API key for the selected provider in the git-ignored `.env` file at the repository root: `GEMINI_API_KEY` for Google or `ANTHROPIC_API_KEY` for Anthropic.

## 2. Quickstart (how to run an existing eval case)

Re-run the existing case `network-config-01` without a skill of your own: every committed run keeps a frozen copy of the skill it evaluated. Results are not expected to be identical (the model's answers vary); the goal is a comparable run. To evaluate your own skill, see [3. How to create your own eval](#3-how-to-create-your-own-eval).

### 2.1 Set up once

```bash
pnpm install --frozen-lockfile

# Create the credential file if it does not already exist
cp -n .env.example .env
```

Edit `.env` and fill in the key for your chosen provider. For the example below, use `GEMINI_API_KEY`. Keep credentials out of command arguments and committed files.

### 2.2 Run, export and inspect

The skill used by a run is already in its folder, at `eval-cases/<case-id>/runs/<run-id>/inputs/frozen/skill/`.

**a. Export.** The run already generated `EVALS.md` and `EVALS-FULL-REPORT.md` inside its run folder. To (re)generate them for a given run, pass its receipt (no other option needed; it runs no git commands):

```bash
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20260924T151721Z-bfb34c20/receipt.json
```

By default the files are written next to the receipt, in `eval-cases/network-config-01/runs/<run-id>/`. `EVALS.md` is the file to share and copy wherever it is needed; `EVALS-FULL-REPORT.md` stays in this repository. To also copy the summary into another existing directory, add `--to <output_dir>`. See [Exports](#exports-evalsmd-and-evals-full-reportmd).

**b. Run one pair.** In case you want to run one pair on your own (paid provider requests; one baseline arm and one treatment arm):

```bash
pnpm eval -- --case network-config-01 \
  --skill "$SKILL_PATH" \
  --model gemini-3.8-flash \
  --limit wallClockMs=300000
```

`wallClockMs=300000` gives each arm five minutes, starting when its prompt begins. Add `--repetitions N` to see how consistent the difference is. For every `pnpm eval` option (model, provider, thinking, limits, reasoning capture), see [Options for `pnpm eval`](#options-for-pnpm-eval). When the run is verified, it prints the receipt path and writes `EVALS.md` and `EVALS-FULL-REPORT.md` into the run folder.

**c. Inspect the run** (reads saved evidence; sends no model requests). This prints the paths of the full agent transcript, a `.jsonl` file and an `.html` file you can open in a browser:

```bash
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view session --export both
```

Want more ways to inspect (other views, specific pairs, older runs)? See [section 5](#5-reference-inspect-options-and-exports).

## 3. How to create your own eval

A case is a folder under `eval-cases/`; adding one needs no change to `src/`.

### 3.1 Create your scoring rubric

The guidelines standardize how we score; each case defines what a correct outcome means.

| Pillar | Measured as |
|---|---|
| Accuracy | Points out of 100 from the case's checks. **Outcome** (80): did the agent correctly and fully deliver what was asked, including the expected response to any predefined failure or invalid input? **Constraints** (20): did it respect the task boundaries and preserve what must not change? |
| Cost | Recorded tokens, including cached input. |
| Latency | Milliseconds from the arm's prompt to completion or termination. |

Each pillar is reported as a baseline → treatment change; with several pairs, as the mean over the pairs.

Declare the checks in `rubric.json` (id, group, display topic, points; `outcome` checks sum to 80 and `constraints` checks to 20) and implement them in `validator.ts` as deterministic predicates. Each check earns its full points or 0, and a full pass needs every check.

### 3.2 Eval case layout

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

**Case `README.md` (optional).** Documentation only, not evidence; no tool reads it. Use the same sections in every case: Why this case exists · The task · How to run it · Scoring rubric (one row per check) · Provenance · Additional context (optional) · Results. See the [network-config-01 README](eval-cases/network-config-01/README.md).

### 3.3 Run your new eval with your skill

There is no import step: `--skill` takes any directory containing `SKILL.md` (no symlinks, no URLs). The runner freezes and hashes a copy into `runs/<run-id>/inputs/frozen/skill/`; never edit it.

```bash
pnpm eval:validate -- --case <case-id> --skill <path_to_skill>      # offline input check
pnpm eval:doctor -- --model <model-id>                              # readiness; no completion requests
pnpm eval -- --case <case-id> --skill <path_to_skill> --model <model-id> [--repetitions N]
```

A verified run writes `EVALS.md` (the file to share) and `EVALS-FULL-REPORT.md` into its run folder. See [Exports](#exports-evalsmd-and-evals-full-reportmd).

## 4. Read the output

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
- For a complete real report, see [this run's EVALS-FULL-REPORT.md](eval-cases/network-config-01/runs/20260924T170734Z-b115674e/EVALS-FULL-REPORT.md).

## 5. Reference: inspect, options and exports

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

### Exports: `EVALS.md` and `EVALS-FULL-REPORT.md`

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

### Evidence and cleanup

Evidence is sealed in `eval-cases/<case-id>/runs/<run-id>/` and committed. A receipt and manifest hash the retained files; `eval:report` and `eval:inspect` verify that chain, so editing a sealed file breaks verification. `views/` (git-ignored) and the two generated reports are outside the chain.

If an interrupted run leaves containers or networks behind: `pnpm eval:recover -- --run <run-id>`.

## 6. Project layout

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
eval-cases/<case-id>/                # One folder per case (see 3.2)
```

To develop the runner, use `pnpm eval:validate`, `pnpm test:evals`, `pnpm test:eval-cases` and `pnpm test:container`. After changing guest runtime sources, run `pnpm build:eval-guest`. Tests use the synthetic skills in `src/test-fixtures/skills/` and never need an external skills checkout.
