<h1 align="center">Arb Evals Guidelines</h1>

<h3 align="center">Measure whether a skill makes an agent better. That's it!</h3>

<p align="center">

[How it works](docs/how-it-works.md) · [Running evals](docs/running-evals.md) · [Create an eval case](docs/create-an-eval-case.md) · [Contributing](docs/contributing.md)

</p>

Arb Evals Guidelines is the repository where eval cases for agentic workflows are stored, together with the sandboxed environment they run in. It compares the same agent **with and without a selected skill**, checks its work, and keeps the evidence so you can inspect the result.

## What is an eval?

An evaluation, or **eval**, is a task with a defined way to judge the answer. Here, each comparison runs that task twice:

1. **Baseline:** the agent has no evaluated skill available.
2. **Treatment:** the same agent has a frozen, unchanged copy of the selected skill available.

Each attempt is called an **arm**. A baseline and treatment together form a **pair**. One command invocation is a **run**, which can contain one or several pairs.

The agent receives a prompt and starting files, does the task, and leaves its answer in the workspace. A **validator** then checks that answer against expected results and assigns a score. An **oracle** is the case's reference data: the expected answers and their sources. It stays hidden from the agent.

Start with one pair to understand the workflow. Repeat the comparison to learn whether an improvement is consistent.

The skill under test can be any directory containing `SKILL.md`, anywhere on disk. This repository holds the runner, the eval cases and the sealed run evidence. You pass the path of one skill directory to `--skill`.

### What does “deterministic” mean here?

The checks are deterministic: **the same captured answer and frozen grading inputs produce the same score**. Another language model does not decide whether the answer looks good.

The agent's answers can still vary between attempts. Deterministic grading gives us a consistent measuring tool; it does not guarantee that the skill improves every answer. Repeated pairs help us see how consistent the observed difference is.

## Requirements

For a measured evaluation, you need:

- **Apple-silicon macOS**, with Apple Container installed and running. Check with `container system status`.
- **Node.js 24.21.0**, the selected evaluation baseline, and **pnpm 10.33.2**.
- This repository and its dependencies, installed with `pnpm install --frozen-lockfile`.
- A skill directory containing `SKILL.md`, anywhere on disk (for an existing run, its frozen copy under `runs/<run-id>/inputs/frozen/skill/`; see [Run, inspect and export](#run-inspect-and-export)).
- An API key for the selected provider in the git-ignored `.env` file at the repository root: `GEMINI_API_KEY` for Google or `ANTHROPIC_API_KEY` for Anthropic.

## Quickstart

Re-run the existing case `network-config-01` without a skill of your own: every committed run keeps a frozen copy of the skill it evaluated. Results are not expected to be identical (the model's answers vary); the goal is a comparable run. To evaluate your own skill, see "Create an eval case" in the links at the top of this page.

### Set up once

```bash
pnpm install --frozen-lockfile

# Create the credential file if it does not already exist
cp -n .env.example .env

# Start the Apple Container runtime
container system start
```

Edit `.env` and fill in the key for your chosen provider. For the example below, use `GEMINI_API_KEY`. Keep credentials out of command arguments and committed files.

### Run, inspect and export

**a. Run one pair** (paid provider requests; one baseline arm and one treatment arm):

```bash
# Set SKILL_PATH to your skill directory (the folder containing SKILL.md).
# The run freezes a copy of it inside
# eval-cases/<case-id>/runs/<run-id>/inputs/frozen/skill/
SKILL_PATH=/path/to/your/skill

pnpm eval -- --case network-config-01 \
  --skill "$SKILL_PATH" \
  --model gemini-3.8-flash \
  --limit wallClockMs=300000
```

To reuse the skill of an existing run, point `SKILL_PATH` at its frozen copy, for example `eval-cases/network-config-01/runs/20261108T093450Z-392b231d/inputs/frozen/skill`.

**b. Inspect the run** (reads saved evidence; sends no model requests). This prints the paths of the full agent transcript, a `.jsonl` file and an `.html` file you can open in a browser:

```bash
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view session --export both
```

**c. Export.** `pnpm eval` already wrote `EVALS.md` (the summary to share) and `EVALS-FULL-REPORT.md` inside the run folder. To (re)generate them for a run, pass its receipt (no other option needed; it runs no git commands). Pairs with an ungraded arm are left out of the `EVALS.md` metrics.

```bash
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/<run-id>/receipt.json
```

To build one combined `EVALS.md` of several runs of the same case, pass each receipt. The result is `eval-cases/<case>/runs/EVALS-<run-id-A>+<run-id-B>.md`; a multi-model `pnpm eval` writes it automatically and prints its path.

```bash
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/<run-id-A>/receipt.json \
  --receipt eval-cases/network-config-01/runs/<run-id-B>/receipt.json
```

Add `--check` to either command to verify the file is up to date without writing it.
