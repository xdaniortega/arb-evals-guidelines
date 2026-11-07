# Network configuration migration — Full evaluation report

| Run context | Recorded value |
|---|---|
| Case | `network-config-01` — network configuration migration |
| Run | `20261105T124949Z-cfc819ba` |
| Skill | `arbitrum-docs` |
| Agent | Pi |
| LLM model | Google Gemini 3.8 Flash |
| Pairs | r001, r002, r003, r004, r005, r006, r007, r008, r009, r010 |

**Baseline** runs without the skill; **Treatment** runs with `arbitrum-docs`.

[Results](#results) · [Pair explorer](#pair-explorer) · [Task and rubric](#task-and-rubric) · [Execution environment](#execution-environment) · [Verify this report](#verify-this-report) · [Export and comparable runs](#export-and-comparable-runs)

## Results

Means across all ten pairs. Recorded token totals include cached input. Latency is the time to completion or termination; a shorter duration does not by itself mean a higher Score.

| Metric | Baseline | Treatment | Change |
|---|---:|---:|---:|
| Score | 20% | 69% | +49% |
| Cost: recorded tokens | 698,606 | 173,219 | −525,387 (−75.2%) |
| Latency | 300,012 ms | 133,444 ms | −166,568 ms (−55.5%) |

The overview displays the Score change as **+49%**, meaning an increase of **49 percentage points** (69% − 20%). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.

### Execution status

| Condition | Execution status | Grading |
|---|---|---|
| Baseline | Task limit reached in all 10 pairs | All 10 graded |
| Treatment | Completed in 8 of 10 pairs; task limit reached in 2 | All 10 graded |

### Score composition

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 50/80 — 63% |
| Constraints and preservation | 20/20 — 100% | 19/20 — 95% |
| **Score total** | **20/100 — 20%** | **69/100 — 69%** |

### Outcome Checks

Mean points earned by each check across the pairs. Each row sums its frozen checks; a row shows `n/a` unless every pair has a verified result for it.

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 8/10 |
| Legacy RPC fallback configuration | 0/10 | 8/10 |
| Public RPC and explorer endpoints | 0/10 | 4/10 |
| Sequencer routing and submission policy | 0/10 | 8/10 |
| WETH and USDC token identities | 0/10 | 8/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 6/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 8/10 |
| **Outcome total** | **0/80** | **50/80** |

### Cost and latency detail

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 698,606 | 173,219 |
| Time to completion or termination (ms) | 300,012 ms | 133,444 ms |

## Pair explorer

All pairs are graded. Open a pair for its full scoring and resource tables.

| Pair | Baseline Score | Treatment Score | Baseline status | Treatment status |
|---|---|---|---|---|
| [r001](#r001) | 20/100 — 20% | 70/100 — 70% | Task limit reached | Completed |
| [r002](#r002) | 20/100 — 20% | 70/100 — 70% | Task limit reached | Completed |
| [r003](#r003) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r004](#r004) | 20/100 — 20% | 80/100 — 80% | Task limit reached | Completed |
| [r005](#r005) | 20/100 — 20% | 20/100 — 20% | Task limit reached | Task limit reached |
| [r006](#r006) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r007](#r007) | 20/100 — 20% | 80/100 — 80% | Task limit reached | Completed |
| [r008](#r008) | 20/100 — 20% | 20/100 — 20% | Task limit reached | Task limit reached |
| [r009](#r009) | 20/100 — 20% | 80/100 — 80% | Task limit reached | Completed |
| [r010](#r010) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |

### r001

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r001`

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
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **50/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 1,928,374 | 165,014 |
| Time to completion or termination (ms) | 300,295 ms | 72,603 ms |

</details>

### r002

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r002`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 10/20 — 50% |
| **Score total** | **20/100 — 20%** | **70/100 — 70%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **60/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 1,932,547 | 106,040 |
| Time to completion or termination (ms) | 300,203 ms | 67,949 ms |

</details>

### r003

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r003`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 895,764 | 81,011 |
| Time to completion or termination (ms) | 300,046 ms | 52,213 ms |

</details>

### r004

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r004`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **80/100 — 80%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **60/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 100,537 | 338,553 |
| Time to completion or termination (ms) | 299,623 ms | 231,250 ms |

</details>

### r005

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r005`

Status: Baseline: task limit reached, graded · Treatment: task limit reached, graded

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
| Total recorded tokens, including cached input | 39,838 | 335,943 |
| Time to completion or termination (ms) | 299,892 ms | 299,748 ms |

</details>

### r006

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r006`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 39,964 | 197,297 |
| Time to completion or termination (ms) | 300,164 ms | 106,134 ms |

</details>

### r007

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r007`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **80/100 — 80%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **60/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 51,960 | 129,450 |
| Time to completion or termination (ms) | 300,134 ms | 80,035 ms |

</details>

### r008

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r008`

Status: Baseline: task limit reached, graded · Treatment: task limit reached, graded

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
| Total recorded tokens, including cached input | 635,474 | 180,932 |
| Time to completion or termination (ms) | 299,779 ms | 299,671 ms |

</details>

### r009

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r009`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **80/100 — 80%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **60/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 1,338,848 | 130,514 |
| Time to completion or termination (ms) | 299,618 ms | 81,733 ms |

</details>

### r010

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261105T124949Z-cfc819ba-r010`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 22,753 | 67,434 |
| Time to completion or termination (ms) | 300,370 ms | 43,103 ms |

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

Score is the presentation name for the original Accuracy metric: outcome points (up to 80) plus constraints and preservation points (up to 20). Aggregate results are means over the recorded pairs; individual-pair tables report that pair only. Outcome Check fractions are points earned, not counts of successful runs.

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
| Evaluator source revision | 79975e9fd5a92dc78e6c0964328627806dbc5caa (dirty working tree) |
| Evaluator build | evals-src@bf86e72b0f5ee310 |
| Image digest(s) | sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0 |
| Skill snapshot tree sha256 | 2315345cfe61ad6c62dcbbdab9d456cab8219e2ff9c51e394751e26bfd801d65 |
| SKILL.md sha256 | 90acb3006d4daf824db78e307281e54669d6b6b73ca12b0f078ad757ae32c36a |
| Provider | google |
| Model | gemini-3.8-flash |
| Thinking level | low |
| Limits | per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited |
| Repetitions | 10 |
| Elapsed | 52m36s wall time |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

| Integrity field | Recorded value |
|---|---|
| Run hash (manifest tree sha256) | `0fd51ed151b308982b3dea28e77fdd3ffdff4c6266b82b3dd16a4026aa16d171` |
| Receipt manifest file sha256 | `93ce07af0fc930aefec8cb60b28a8fa13d74b2a6c479a53c01c16097cad2a9af` |

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/receipt.json --checks
```

## Export and comparable runs

### Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/receipt.json --to <output_dir> --pair r001
```

### Reproducibility

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model gemini-3.8-flash --thinking low --repetitions 10
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
