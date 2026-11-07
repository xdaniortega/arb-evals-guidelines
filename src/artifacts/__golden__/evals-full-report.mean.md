> **Warning:** TEST-DOUBLE EVIDENCE — synthetic scores, not a measured result

# Network configuration migration — Full evaluation report

| Run context | Recorded value |
|---|---|
| Case | `network-config-01` — network configuration migration |
| Run | `19700101T000000Z-abcdef12` |
| Skill | `mcp-skill` |
| Agent | fake |
| LLM model | Google Fake Model 0 |
| Pairs | r001, r002, r003 |

**Baseline** runs without the skill; **Treatment** runs with `mcp-skill`.

[Results](#results) · [Pair explorer](#pair-explorer) · [Task and rubric](#task-and-rubric) · [Execution environment](#execution-environment) · [Verify this report](#verify-this-report) · [Export and comparable runs](#export-and-comparable-runs)

## Results

Score and Outcome Checks are means across all three pairs. Token and latency means use only the pairs with a recorded value (0 of 3 pairs have both recorded for both arms). Recorded token totals include cached input. Latency is the time to completion or termination; a shorter duration does not by itself mean a higher Score.

| Metric | Baseline | Treatment | Change |
|---|---:|---:|---:|
| Score | 20% | 20% | 0% |
| Cost: recorded tokens | n/a | n/a | n/a |
| Latency | 0 ms | 0 ms | 0 ms (n/a) |

The Score change is **0%**, meaning **0 percentage points** (20% − 20%). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.

### Execution status

| Condition | Execution status | Grading |
|---|---|---|
| Baseline | Completed in all 3 pairs | All 3 graded |
| Treatment | Completed in all 3 pairs | All 3 graded |

### Score composition

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 0/80 — 0% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **20/100 — 20%** |

### Outcome Checks

Mean points earned by each check across the pairs. Each row sums its frozen checks; a row shows `n/a` unless every pair has a verified result for it.

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 0/10 |
| Legacy RPC fallback configuration | 0/10 | 0/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 0/10 |
| WETH and USDC token identities | 0/10 | 0/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 0/10 |
| **Outcome total** | **0/80** | **0/80** |

### Cost and latency detail

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | n/a | n/a |
| Time to completion or termination (ms) | 0 ms | 0 ms |

## Pair explorer

All pairs are graded. Open a pair for its full scoring and resource tables.

| Pair | Baseline Score | Treatment Score | Baseline status | Treatment status |
|---|---|---|---|---|
| [r001](#r001) | 20/100 — 20% | 20/100 — 20% | Completed | Completed |
| [r002](#r002) | 20/100 — 20% | 20/100 — 20% | Completed | Completed |
| [r003](#r003) | 20/100 — 20% | 20/100 — 20% | Completed | Completed |

### r001

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `19700101T000000Z-abcdef12-r001`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 0/80 — 0% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **20/100 — 20%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 0/10 |
| Legacy RPC fallback configuration | 0/10 | 0/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 0/10 |
| WETH and USDC token identities | 0/10 | 0/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 0/10 |
| **Outcome total** | **0/80** | **0/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | n/a | n/a |
| Time to completion or termination (ms) | 0 ms | 0 ms |

</details>

### r002

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `19700101T000000Z-abcdef12-r002`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 0/80 — 0% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **20/100 — 20%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 0/10 |
| Legacy RPC fallback configuration | 0/10 | 0/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 0/10 |
| WETH and USDC token identities | 0/10 | 0/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 0/10 |
| **Outcome total** | **0/80** | **0/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | n/a | n/a |
| Time to completion or termination (ms) | 0 ms | 0 ms |

</details>

### r003

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `19700101T000000Z-abcdef12-r003`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 0/80 — 0% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **20/100 — 20%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 0/10 |
| Legacy RPC fallback configuration | 0/10 | 0/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 0/10 |
| WETH and USDC token identities | 0/10 | 0/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 0/10 |
| **Outcome total** | **0/80** | **0/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | n/a | n/a |
| Time to completion or termination (ms) | 0 ms | 0 ms |

</details>

## Task and rubric

**Scenario:** Migrate production and staging network configuration to Arbitrum

| Case definition | Recorded value |
|---|---|
| Case | network-config-01, version 11 |
| Rubric version | v0.2 |
| Allowed tools | read, bash, edit, write, grep, find, ls |
| Output path | config.json |

**Prompt (verbatim)**

```text
Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.
```

The frozen inputs above are authoritative. This section is explanatory only and is not evidence.

### Scoring rules and interpretation

Score is the presentation name for the original Accuracy metric: outcome points (up to 80) plus constraints and preservation points (up to 20). Aggregate results are means over the recorded pairs; individual-pair tables report that pair only. Outcome Check fractions are points earned, not counts of successful runs.

### Frozen checks and weights

| Check | Group | Topic | Points |
|---|---|---|---|
| production-chain-identity | outcome | Correct network identities | 5 |
| staging-chain-identity | outcome | Correct network identities | 5 |
| production-legacy-fallback | outcome | Legacy RPC fallback configuration | 5 |
| staging-legacy-fallback | outcome | Legacy RPC fallback configuration | 5 |
| rpc-routing | outcome | Public RPC and explorer endpoints | 5 |
| write-rpc-provider | outcome | Public RPC and explorer endpoints | 5 |
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
| LLM model | Google Fake Model 0 |
| Registered model ID | `google/fake-model-0` |

| Execution / provenance field | Recorded value |
|---|---|
| Evaluator source revision | 0000000000000000000000000000000000000000 (clean) |
| Evaluator build | evals-src@test |
| Image digest(s) | sha256:<sha256> |
| Skill snapshot tree sha256 | <sha256> |
| SKILL.md sha256 | <sha256> |
| Provider | google |
| Model | fake-model-0 |
| Thinking level | off |
| Limits | per arm: time=unlimited, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited |
| Repetitions | 3 |
| Elapsed | <elapsed> |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

| Integrity field | Recorded value |
|---|---|
| Run hash (manifest tree sha256) | `<sha256>` |
| Receipt manifest file sha256 | `<sha256>` |

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/19700101T000000Z-abcdef12/receipt.json --checks
```

## Export and comparable runs

### Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/19700101T000000Z-abcdef12/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/19700101T000000Z-abcdef12/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/19700101T000000Z-abcdef12/receipt.json --to <output_dir> --pair r001
```

### Reproducibility

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model fake-model-0 --thinking off --repetitions 3
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
