# Network configuration migration — Full evaluation report

| Run context | Recorded value |
|---|---|
| Case | `network-config-01` — network configuration migration |
| Run | `20261105T165811Z-2934dba4` |
| Skill | `arbitrum-docs` |
| Agent | Pi |
| LLM model | Google Gemini 3.8 Flash |
| Pairs | r001 |

**Baseline** runs without the skill; **Treatment** runs with `arbitrum-docs`.

[Results](#results) · [Pair explorer](#pair-explorer) · [Task and rubric](#task-and-rubric) · [Execution environment](#execution-environment) · [Verify this report](#verify-this-report) · [Export and comparable runs](#export-and-comparable-runs)

## Results

Results of the single pair r001. Recorded token totals include cached input. Latency is the time to completion or termination; a shorter duration does not by itself mean a higher Score.

| Metric | Baseline | Treatment | Change |
|---|---:|---:|---:|
| Score | 20% | 70% | +50% |
| Cost: recorded tokens | 281,790 | 340,794 | +59,004 (+20.9%) |
| Latency | 300,386 ms | 224,860 ms | −75,526 ms (−25.1%) |

The overview displays the Score change as **+50%**, meaning an increase of **50 percentage points** (70% − 20%). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.

### Execution status

| Condition | Execution status | Grading |
|---|---|---|
| Baseline | Task limit reached | Graded |
| Treatment | Completed | Graded |

### Score composition

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 50/80 — 63% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **70/100 — 70%** |

### Outcome Checks

Points earned by each check in the single pair. Each row sums its frozen checks.

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 0/10 |
| Public RPC and explorer endpoints | 0/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **50/80** |

### Cost and latency detail

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 281,790 | 340,794 |
| Time to completion or termination (ms) | 300,386 ms | 224,860 ms |

## Pair explorer

The pair is graded. Open a pair for its full scoring and resource tables.

| Pair | Baseline Score | Treatment Score | Baseline status | Treatment status |
|---|---|---|---|---|
| [r001](#r001) | 20/100 — 20% | 70/100 — 70% | Task limit reached | Completed |

### r001

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T165811Z-2934dba4-r001`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 50/80 — 63% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **70/100 — 70%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 0/10 |
| Public RPC and explorer endpoints | 0/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **50/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 281,790 | 340,794 |
| Time to completion or termination (ms) | 300,386 ms | 224,860 ms |

</details>

## Task and rubric

**Scenario:** Migrate production and staging network configuration to Arbitrum

| Case definition | Recorded value |
|---|---|
| Case | network-config-01, version 10 |
| Rubric version | v0.2 |
| Allowed tools | read, bash, edit, write, grep, find, ls |
| Output path | config.json |

**Prompt (verbatim)**

```text
Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.
```

[Current case documentation](https://github.com/xdaniortega/evals-example/blob/HEAD/eval-cases/network-config-01/README.md); the frozen inputs above are authoritative. This section is explanatory only and is not evidence.

### Scoring rules and interpretation

Score is the presentation name for the original Accuracy metric: outcome points (up to 80) plus constraints and preservation points (up to 20). Outcome Check fractions are points earned, not counts of successful runs.

### Frozen checks and weights

| Check | Group | Topic | Points |
|---|---|---|---|
| production-chain-identity | outcome | Correct network identities | 5 |
| staging-chain-identity | outcome | Correct network identities | 5 |
| production-legacy-fallback | outcome | Legacy RPC fallback configuration | 5 |
| staging-legacy-fallback | outcome | Legacy RPC fallback configuration | 5 |
| production-rpc-endpoints | outcome | Public RPC and explorer endpoints | 5 |
| staging-rpc-endpoints | outcome | Public RPC and explorer endpoints | 5 |
| production-sequencer-policy | outcome | Sequencer routing and submission policy | 5 |
| staging-sequencer-policy | outcome | Sequencer routing and submission policy | 5 |
| production-token-identity | outcome | WETH and USDC token identities | 5 |
| staging-token-identity | outcome | WETH and USDC token identities | 5 |
| production-bridge-addresses | outcome | Canonical bridge addresses | 5 |
| staging-bridge-addresses | outcome | Canonical bridge addresses | 5 |
| production-bridge-onboarding | outcome | Bridge onboarding configuration | 5 |
| staging-bridge-onboarding | outcome | Bridge onboarding configuration | 5 |
| production-finality-policy | outcome | Withdrawal finality and force-inclusion settings | 5 |
| staging-finality-policy | outcome | Withdrawal finality and force-inclusion settings | 5 |
| json-shape | constraints |  | 10 |
| preservation | constraints |  | 10 |

## Execution environment

| Model field | Recorded value |
|---|---|
| LLM model | Google Gemini 3.8 Flash |
| Registered model ID | `google/gemini-3.8-flash` |

| Execution / provenance field | Recorded value |
|---|---|
| Evaluator source revision | 8ad9c913889ba09190770697be7e1bd98b2f1b15 (dirty working tree) |
| Evaluator build | evals-src@a568ac7368172786 |
| Image digest(s) | sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0 |
| Skill snapshot tree sha256 | 60b5db9aa8b20b56517ca318db69ea6346a58b6c1ca97b564f1ba2b38d4cb36a |
| SKILL.md sha256 | 1fa7b75c98f170ff15a7f630e91f0d27808c4d3dad287adf5bb7d7fb9f2c61cf |
| Provider | google |
| Model | gemini-3.8-flash |
| Thinking level | low |
| Limits | per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited |
| Repetitions | 1 |
| Elapsed | 5m15s wall time |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

| Integrity field | Recorded value |
|---|---|
| Run hash (manifest tree sha256) | `05b666900e8e926e6b6ef6240d7740990350cba43fc500c8a3bf76bcd8ed091a` |
| Receipt manifest file sha256 | `edb3bdf5305693530b77cfc20b8a2a2cc72ab03374c56de20839a7b8d1417369` |

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20261105T165811Z-2934dba4/receipt.json --checks
```

## Export and comparable runs

### Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261105T165811Z-2934dba4/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261105T165811Z-2934dba4/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261105T165811Z-2934dba4/receipt.json --to <output_dir> --pair r001
```

### Reproducibility

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model gemini-3.8-flash --thinking low --repetitions 1
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
