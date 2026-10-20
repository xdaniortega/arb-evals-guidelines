# Arbitrum Evaluation Framework

<p align="center">
  <img src="assets/arbitrum-evaluation-framework.svg" alt="Arbitrum Agent Skills"">
</p>


Does a skill help an agent do a task better? This framework compares the same agent **with and without a selected skill**, checks its work, and keeps the evidence so you can inspect the result.

Start with one pair to understand the workflow. Repeat the comparison to learn whether an improvement is consistent.

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
- An API key for the selected provider in the git-ignored `evals/.env` file: `GEMINI_API_KEY` for Google or `ANTHROPIC_API_KEY` for Anthropic.
## 2. Quick start
### Set up once

```bash
pnpm install --frozen-lockfile

# Create the credential file if it does not already exist
cp -n evals/.env.example evals/.env
```

Edit `evals/.env` and fill in the key for your chosen provider. For the example below, use `GEMINI_API_KEY`. Keep credentials out of command arguments and committed files.

### Check readiness, then run one pair

```bash
# Check environment readiness; sends no completion requests
pnpm eval:doctor -- --model gemini-3.8-flash --thinking low

# Run one baseline/treatment pair with paid provider requests
pnpm eval -- --case network-config-01 \
  --skill skills/arbitrum-docs \
  --model gemini-3.8-flash \
  --limit wallClockMs=300000
```
The `wallClockMs=300000` limit gives each arm five minutes, starting when its prompt begins.


Other Options for `pnpm eval`:

| Option | What it does |
|---|---|
| `--case <id>` | Case to run. Required. |
| `--skill <path>` | Treatment skill, relative to the repository. The baseline arm receives none. Required, unless you use the legacy `--suite` flag. |
| `--model <id>` | Model to call. Required for a measured run. The provider is inferred from the model id. |
| `--provider <google\|anthropic>` | Asserts or disambiguates the provider when the model id alone is not enough. |
| `--thinking <level>` | Reasoning effort. Default `low`. Names are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; a model may reject some of them. |
| `--repetitions <n>` | How many baseline/treatment pairs to run. Default `1`. |
| `--capture-reasoning` | Keeps the model's reasoning in the saved session. Off by default, because it makes the session much larger. |
| `--limit <key>=<value>` | Overrides one budget. Repeat the flag for several keys. Task budgets (`wallClockMs`, `maxOutputTokens`, `maxToolSteps`, `maxProviderRequests`) take a positive integer, or `0` / `none` for unlimited. Resource bounds (`cpus`, `memoryMiB`, `pids`, `diskMiB`, `maxExportedFiles`, `maxExportedFileBytes`, `maxWorkspaceBytes`) stay finite. |


The example case asks the agent to migrate an application's production and staging configuration from Ethereum to Arbitrum One and Arbitrum Sepolia, while preserving unrelated settings. Read its [prompt](cases/network-config-01/case.json) and [starting configuration](cases/network-config-01/fixture/config.json) to understand the task before interpreting its score.

## 3. How scoring works

### A shared scoring rubric

The framework standardizes how we score; each case defines what a correct outcome means.

| Pillar | Common definition | What each case supplies |
|---|---|---|
| Accuracy | A percentage of how well the agent fulfilled the requested task. | Expected outcomes, checks, evidence and passing conditions. |
| Cost | Resources consumed to perform the task, in tokens or monetary terms. | Cost delta: baseline vs treatment mean over at least X runs. |
| Latency | Time from task start to completion or termination (ms or s). | Time delta: baseline vs treatment mean over at least X runs. |

Accuracy is split into two parts:

| Accuracy pillar | Weight | Question it answers |
|---|---:|---|
| Outcome correctness and completeness | 80% | Did the agent correctly and fully deliver everything requested? Check that the result matches the expected facts, values, behavior or state across the full requested scope. Where the case introduces a predefined failure, invalid input or unmet prerequisite, check that the agent identifies it and responds as expected (recover, ask, or stop). |
| Constraints and preservation | 20% | Did the agent respect permissions and task boundaries while preserving what should remain unchanged? |

## 4. Read the output

A single-pair run prints the same sections, labels and values as the published `EVALS.md`, followed by an operational footer. Example (illustrative values):

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
│ Latency               │              5m00s │           1m30s │       −3m30s (−70.0%) │
└───────────────────────┴────────────────────┴─────────────────┴───────────────────────┘

Scenario: Migrate production and staging network configuration to Arbitrum

Accuracy:
┌──────────────────────────────────────┬────────────────────┬─────────────────┐
│ Check                                │ Without this skill │ With this skill │
├──────────────────────────────────────┼────────────────────┼─────────────────┤
│ Outcome correctness and completeness │        10/80 — 13% │     65/80 — 81% │
│ Constraints and preservation         │       20/20 — 100% │    20/20 — 100% │
├──────────────────────────────────────┼────────────────────┼─────────────────┤
│ Accuracy total                       │       30/100 — 30% │    85/100 — 85% │
└──────────────────────────────────────┴────────────────────┴─────────────────┘

Cost and latency:
┌───────────────────────────────────────────────┬────────────────────┬─────────────────┐
│ Metric                                        │ Without this skill │ With this skill │
├───────────────────────────────────────────────┼────────────────────┼─────────────────┤
│ Total recorded tokens, including cached input │          2,106,273 │         921,312 │
│ Time to completion or termination             │          5m00.155s │       1m29.975s │
└───────────────────────────────────────────────┴────────────────────┴─────────────────┘

limits    per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited
elapsed   5m13s wall time
receipt   evals/cases/network-config-01/runs/20261002T101500Z-3f9a1c2d/receipt.json
inspect   pnpm eval:inspect --receipt <receipt> --pair r001 --condition treatment --view session --export both
publish   pnpm eval:publish --receipt <receipt> --checks
```

- Add `--checks` to `eval`, `eval:report` or `eval:publish` to include the **Outcome checks** table (one row per display topic, with an **Outcome total**).
- An arm without grading evidence (for example, interrupted before its workspace was exported) shows `n/a` in every accuracy cell and in the change column. When its recorded duration is missing, latency is derived from the native session and labelled `(session-derived)`; changes that use it are labelled `approximate`.


## 5. How to inspect a run

Inspection reads saved evidence and sends no new model requests. Every command below follows the same shape: `pnpm eval:inspect -- --latest --case <case-id> --condition <baseline|treatment> --view <name>`.

### Step 1: find your run

```bash
pnpm eval:history -- --latest --case network-config-01
```

This prints the receipt path and pair identifiers for your most recent run of that case. For several repetitions, note a specific `--pair <pair-id>` here; every command below accepts it.

### Step 2: open the session

The **session** is the agent's actual transcript: every message, tool call, tool result, and the model's reasoning, in order.

```bash
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view session --export both
```

This prints two paths: a `.jsonl` file (Pi's native session, one JSON record per line) and an `.html` file. **Open the HTML path in a browser.** It shows the same transcript as a collapsible page: messages, reasoning, tool calls, and tool results. Guarded secrets appear as `[REDACTED:<label>]`; everything else is exactly what the model produced.

Repeat with `--condition baseline` to see the same task without the skill, and compare the two transcripts side by side.

> **This evidence is private.** When captured with `--capture-reasoning`, a session keeps the model's reasoning verbatim; treat it like any other local debugging artifact: it lives only in your `evals/cases/<case-id>/runs/<run-id>/` directory (git-ignored) and is never uploaded anywhere by this framework. Sanitization removes guarded secrets, not the reasoning itself — don't paste a session export somewhere public.
>
> The `--capture-reasoning` CLI flag exists so that model reasoning can be retained when we specifically want to analyze the model's reasoning; it is off by default because reasoning substantially increases session artifact size.

### Step 3: check the result

```bash
# See the final answer
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view candidate

# See which checks passed or failed, and why
pnpm eval:inspect -- --latest --case network-config-01 \
  --condition treatment --view validation
```

Compare the session's tool calls with the final answer and the validator's explanations to understand *why* a run scored the way it did. Available sessions may be incomplete after an interrupted run.

### Other views

| `--view`      | Shows                                                              |
| ------------- | ------------------------------------------------------------------- |
| `session`     | The full transcript: messages, tool calls, reasoning (see Step 2). |
| `messages`    | Just the message text, derived from the session.                   |
| `tools`       | Just the tool calls and their results, derived from the session.   |
| `candidate`   | The final answer the validator scored.                              |
| `validation`  | Per-check pass/fail and the resulting score.                        |
| `workspace`   | The files the agent left behind.                                    |
| `condition`   | Status, timing, and usage for one arm.                               |
| `errors`      | What went wrong, for a failed or infrastructure-failed arm.          |
| `runtime`     | The resolved model, provider, and thinking level actually used.      |
| `attestation` | The observed guest policy (tools, network, skill) the arm actually ran under. |
| `redactions`  | How many secret occurrences were redacted, and where.                |

To keep inspecting one specific run as newer runs arrive, replace `--latest --case network-config-01` with `--receipt "<receipt-path>"`:

```bash
# Print the saved comparison again; replace the placeholder with a real receipt path
pnpm eval:report -- --receipt "<receipt-path>" --format table
```

### Publishing verified evaluation results

After verifying evaluation evidence, publish the scored report to the evaluated skill's `EVALS.md`:

```bash
pnpm eval:publish -- --receipt "<receipt-path>" [--checks]
```

The publish command:
- Verifies run evidence first (`verifyRun`); refuses to publish if verification fails.
- Derives the destination skill from `inputs/skill-snapshot.json.sourcePath` (e.g. `skills/arbitrum-docs`).
- Updates a bounded generated results section delimited by `<!-- AF-EVAL:BEGIN generated -->` and `<!-- AF-EVAL:END generated -->` in `<skillSourcePath>/EVALS.md`.
- Idempotently replaces the generated block on subsequent runs while preserving all authored coverage notes verbatim outside the markers.
- Includes an AF-Evaluation status badge (`<status> · <treatment accuracy>%`; describes execution/grading status, non-certifying).
- Refuses single-pair runs where either arm is ungraded; re-run the case instead of publishing `n/a`.
- Keeps the receipt path and operational footer outside `EVALS.md`.
- Ordinary `eval` and `eval:report` commands never modify `EVALS.md`.

Evidence is stored locally in `evals/cases/<case-id>/runs/<run-id>/`. A receipt and manifest record hashes of the retained files; `eval:report` and `eval:inspect` verify that chain before trusting the result, so editing a sealed file invalidates verification. Session exports (`views/*.jsonl`, `views/*.html`) are generated read-only views outside that chain and never change the sealed evidence.

If an interrupted run leaves containers or networks behind, clean up its recorded resources with `pnpm eval:recover -- --run <run-id>`.

## 6. Project layout

```text
evals/
├── README.md                # Human guide to running and understanding evals
├── .env.example             # Credential template; copy locally to .env
├── tsconfig.json            # Evaluation TypeScript configuration
├── container/               # Guest image, network setup and locked runtime
├── src/
│   ├── core/                # Schemas, comparison rules, limits and redaction
│   ├── runner/              # Setup, case loading and paired-run orchestration
│   ├── harnesses/           # Agent execution through Pi or test doubles
│   ├── sandboxes/           # Container lifecycle and test doubles
│   └── artifacts/           # Saved evidence, verification and report readers
├── scripts/                 # Command-line entrypoints
└── cases/
    └── network-config-01/   # Application configuration migration case
        ├── case.json        # Task prompt, output path and allowed tools
        ├── fixture/         # Starting workspace shared by both arms
        ├── oracle.json      # Hidden expected answers and their sources
        ├── validator.ts     # Deterministic checks, run in a separate container
        ├── validator.test.ts # Wrong-answer and accepted-variant tests
        └── runs/            # Local, git-ignored evidence created by runs
```

Skill coverage and result summaries live alongside the evaluated skill, for example [skills/arbitrum-docs/EVALS.md](../skills/arbitrum-docs/EVALS.md). Single-pair records carry their own context; they do not establish a statistical result.

For framework development, use `pnpm eval:validate`, `pnpm test:evals`, `pnpm test:eval-cases` and `pnpm test:container`. After changing guest runtime sources, run `pnpm build:eval-guest` to refresh generated artifacts and locks.

## 7. Documenting a case

Each case README should answer these questions; the validator defines the actual scoring and passing rules.

- **Provenance** — the reference answers, their sources and when those sources were checked.
- **Checks and weights** — each check, its group (`outcome` or `constraints`), its points and rationale, and any facts grouped within a check.
- **Unhappy paths** — which outcome checks exercise a predefined failure, invalid input or unmet prerequisite, and the expected response.
- **Accepted variants** — which differences are harmless (such as permitted formatting) and which requirements must remain exact.
- **Preservation** — what must remain unchanged and which constraint checks enforce it.
- **Score endpoints** — the expected score and pass result for correct, unchanged, malformed and missing answers.

See the [network-config-01 README](cases/network-config-01/README.md) for an example.
