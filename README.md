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

For all export options, see [Export](eval-cases/README.md#6-export-evalsmd-and-evals-full-reportmd).

**b. Run one pair.** In case you want to run one pair on your own (paid provider requests; one baseline arm and one treatment arm):

```bash
pnpm eval -- --case network-config-01 \
  --skill "$SKILL_PATH" \
  --model gemini-3.8-flash \
  --limit wallClockMs=300000
```

For every `pnpm eval` option (model, provider, thinking, limits, reasoning capture), see [Options for `pnpm eval`](eval-cases/README.md#options-for-pnpm-eval).

**c. Inspect the run** (reads saved evidence; sends no model requests). This prints the paths of the full agent transcript, a `.jsonl` file and an `.html` file you can open in a browser:

```bash
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view session --export both
```

Want more ways to inspect (other views, specific pairs, older runs)? See [Inspect a run](eval-cases/README.md#5-inspect-a-run).

## 3. How to create your own eval

A case is a folder under `eval-cases/`; adding one needs no change to `src/`. Everything specific to eval cases lives in [`eval-cases/README.md`](eval-cases/README.md):

- [What an eval case is](eval-cases/README.md#1-what-is-an-eval-case) and how the runner uses each file.
- [The scoring rubric](eval-cases/README.md#2-scoring-rubric): pillars, checks and weights.
- [The case layout](eval-cases/README.md#3-case-layout), using `network-config-01` as a template.
- [Running your eval with your skill](eval-cases/README.md#4-run-your-eval-with-your-skill).
- [Inspecting a run and every `pnpm eval` option](eval-cases/README.md#5-inspect-a-run).
- [Exporting `EVALS.md` and `EVALS-FULL-REPORT.md`](eval-cases/README.md#6-export-evalsmd-and-evals-full-reportmd).
- [Evidence and cleanup](eval-cases/README.md#7-evidence-and-cleanup).
- [The project layout](eval-cases/README.md#8-project-layout).

When your case is ready, see [How to submit your eval case](#how-to-submit-your-eval-case).

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

## 5. Inspect a run and options

How to inspect a run (sessions, answers, validation and other views) and every `pnpm eval` option are described in [`eval-cases/README.md`](eval-cases/README.md#5-inspect-a-run).

## How to submit your eval case

Open a PR against this repository that adds your case under `eval-cases/<case-id>/`. Use [`network-config-01`](eval-cases/network-config-01/) as the reference: your PR must contain the same content.

1. **The case files:** `case.json`, `fixture/`, `oracle.json`, `rubric.json`, `validator.ts` and `validator.test.ts`, plus a case `README.md` with the standard sections (see [Case layout](eval-cases/README.md#3-case-layout)).
2. **At least one sealed run** under `eval-cases/<case-id>/runs/<run-id>/`, produced by `pnpm eval` with the skill you evaluated, including its generated `EVALS.md` and `EVALS-FULL-REPORT.md`. Do not edit anything in the run folder by hand.
3. **Passing checks** before you open the PR:

   ```bash
   pnpm test:eval-cases
   pnpm eval:validate -- --case <case-id> --skill <path_to_skill>
   pnpm eval:export -- --check --all
   ```

4. **No secrets and no local files.** Keep `.env`, `.state/` and `views/` out of the PR.

If your skill lives in another repository, merge this PR first so the full-report link in its `EVALS.md` resolves (see [Export](eval-cases/README.md#6-export-evalsmd-and-evals-full-reportmd)).

## Contributing

Contributions to the Evals Guidelines code (runner, harnesses, sandboxes, scoring, reporting and documentation) are welcome. Open a PR against this repository with your proposed changes.

- Read [`AGENTS.md`](AGENTS.md) first: it lists the guarantees that must not be weakened and which checks to run for each kind of change.
- Use Conventional Commits (for example `fix(evals): refuse export of ungraded pairs`).

To add a new eval case, see [How to submit your eval case](#how-to-submit-your-eval-case) instead.
