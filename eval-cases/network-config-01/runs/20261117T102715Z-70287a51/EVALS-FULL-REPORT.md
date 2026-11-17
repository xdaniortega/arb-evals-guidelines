# Network configuration migration — Full evaluation report

| Run context | Recorded value |
|---|---|
| Case | `network-config-01` — network configuration migration |
| Run | `20261117T102715Z-70287a51` |
| Skill | `arbitrum-docs` |
| Agent | Pi |
| LLM model | Google Gemini 4 Argon |
| Pairs | r001, r002, r003, r004, r005, r006, r007, r008, r009, r010 |

**Baseline** runs without the skill; **Treatment** runs with `arbitrum-docs`.

[Results](#results) · [Pair explorer](#pair-explorer) · [Task and rubric](#task-and-rubric) · [Execution environment](#execution-environment) · [Verify this report](#verify-this-report) · [Export and comparable runs](#export-and-comparable-runs)

## Results

Means across all ten pairs. Recorded token totals include cached input. Latency is the time to completion or termination; a shorter duration does not by itself mean a higher Score.

| Metric | Baseline | Treatment | Change |
|---|---:|---:|---:|
| Score | 71% | 90% | +19% |
| Cost: recorded tokens | 335,566 | 52,307 | −283,259 (−84.4%) |
| Latency | 340,495 ms | 128,457 ms | −212,038 ms (−62.3%) |

The overview displays the Score change as **+19%**, meaning an increase of **19 percentage points** (90% − 71%). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.

### Execution status

| Condition | Execution status | Grading |
|---|---|---|
| Baseline | Completed in all 10 pairs | All 10 graded |
| Treatment | Completed in all 10 pairs | All 10 graded |

### Score composition

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 57/80 — 71% | 72/80 — 90% |
| Constraints and preservation | 14/20 — 70% | 18/20 — 90% |
| **Score total** | **71/100 — 71%** | **90/100 — 90%** |

### Outcome Checks

Mean points earned by each check across the pairs. Each row sums its frozen checks; a row shows `n/a` unless every pair has a verified result for it.

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 8/10 | 10/10 |
| Sequencer routing and submission policy | 3/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 2/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 6/10 | 10/10 |
| **Outcome total** | **57/80** | **72/80** |

### Cost and latency detail

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 335,566 | 52,307 |
| Time to completion or termination (ms) | 340,495 ms | 128,457 ms |

## Pair explorer

All pairs are graded. Open a pair for its full scoring and resource tables.

| Pair | Baseline Score | Treatment Score | Baseline status | Treatment status |
|---|---|---|---|---|
| [r001](#r001) | 65/100 — 65% | 90/100 — 90% | Completed | Completed |
| [r002](#r002) | 60/100 — 60% | 90/100 — 90% | Completed | Completed |
| [r003](#r003) | 80/100 — 80% | 90/100 — 90% | Completed | Completed |
| [r004](#r004) | 85/100 — 85% | 90/100 — 90% | Completed | Completed |
| [r005](#r005) | 80/100 — 80% | 90/100 — 90% | Completed | Completed |
| [r006](#r006) | 80/100 — 80% | 90/100 — 90% | Completed | Completed |
| [r007](#r007) | 70/100 — 70% | 90/100 — 90% | Completed | Completed |
| [r008](#r008) | 55/100 — 55% | 90/100 — 90% | Completed | Completed |
| [r009](#r009) | 70/100 — 70% | 90/100 — 90% | Completed | Completed |
| [r010](#r010) | 65/100 — 65% | 90/100 — 90% | Completed | Completed |

### r001

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r001`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 55/80 — 69% | 70/80 — 88% |
| Constraints and preservation | 10/20 — 50% | 20/20 — 100% |
| **Score total** | **65/100 — 65%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 5/10 | 10/10 |
| **Outcome total** | **55/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 45,261 | 54,915 |
| Time to completion or termination (ms) | 118,298 ms | 195,794 ms |

</details>

### r002

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r002`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 50/80 — 63% | 70/80 — 88% |
| Constraints and preservation | 10/20 — 50% | 20/20 — 100% |
| **Score total** | **60/100 — 60%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **50/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 43,706 | 49,148 |
| Time to completion or termination (ms) | 386,313 ms | 73,567 ms |

</details>

### r003

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r003`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 60/80 — 75% | 80/80 — 100% |
| Constraints and preservation | 20/20 — 100% | 10/20 — 50% |
| **Score total** | **80/100 — 80%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 10/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 10/10 | 10/10 |
| **Outcome total** | **60/80** | **80/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 51,220 | 47,103 |
| Time to completion or termination (ms) | 152,662 ms | 248,509 ms |

</details>

### r004

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r004`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 65/80 — 81% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **85/100 — 85%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 10/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 5/10 | 10/10 |
| **Outcome total** | **65/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 733,973 | 55,475 |
| Time to completion or termination (ms) | 711,790 ms | 103,624 ms |

</details>

### r005

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r005`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 60/80 — 75% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **80/100 — 80%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 10/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 5/10 | 10/10 |
| **Outcome total** | **60/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 1,370,211 | 45,525 |
| Time to completion or termination (ms) | 720,355 ms | 101,092 ms |

</details>

### r006

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r006`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 60/80 — 75% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **80/100 — 80%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 10/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 5/10 | 10/10 |
| **Outcome total** | **60/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 897,647 | 54,861 |
| Time to completion or termination (ms) | 782,336 ms | 185,905 ms |

</details>

### r007

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r007`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 60/80 — 75% | 70/80 — 88% |
| Constraints and preservation | 10/20 — 50% | 20/20 — 100% |
| **Score total** | **70/100 — 70%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 10/10 | 10/10 |
| **Outcome total** | **60/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 40,414 | 58,494 |
| Time to completion or termination (ms) | 147,234 ms | 99,339 ms |

</details>

### r008

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r008`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 45/80 — 56% | 70/80 — 88% |
| Constraints and preservation | 10/20 — 50% | 20/20 — 100% |
| **Score total** | **55/100 — 55%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **45/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 110,131 | 55,490 |
| Time to completion or termination (ms) | 172,052 ms | 69,829 ms |

</details>

### r009

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r009`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 60/80 — 75% | 70/80 — 88% |
| Constraints and preservation | 10/20 — 50% | 20/20 — 100% |
| **Score total** | **70/100 — 70%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 10/10 | 10/10 |
| **Outcome total** | **60/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 37,688 | 54,928 |
| Time to completion or termination (ms) | 144,688 ms | 113,596 ms |

</details>

### r010

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T102715Z-70287a51-r010`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 55/80 — 69% | 80/80 — 100% |
| Constraints and preservation | 10/20 — 50% | 10/20 — 50% |
| **Score total** | **65/100 — 65%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 10/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 10/10 | 10/10 |
| **Outcome total** | **55/80** | **80/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 25,408 | 47,133 |
| Time to completion or termination (ms) | 69,217 ms | 93,315 ms |

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

[Current case documentation](https://github.com/xdaniortega/arb-evals-guidelines/blob/HEAD/eval-cases/network-config-01/README.md); the frozen inputs above are authoritative. This section is explanatory only and is not evidence.

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
| LLM model | Google Gemini 4 Argon |
| Registered model ID | `google/gemini-4-argon` |

| Execution / provenance field | Recorded value |
|---|---|
| Evaluator source revision | f1196bc72174268ec7d2aea0261433309497f182 (clean) |
| Evaluator build | evals-src@4a25be9cb0848d1d |
| Image digest(s) | sha256:690d42e7f07809075607282e6c81d6e4734ab6d124946887d5ec60ec4bb0787a |
| Skill snapshot tree sha256 | 6596dc2374114d6848489f46860ef0cc6959bb2ab936ca7d38ece5a638040d03 |
| SKILL.md sha256 | 21aa527276505c54eb6e84e5b35c64a848880116ba3f07449e1879f88b0d2339 |
| Provider | google |
| Model | gemini-4-argon |
| Thinking level | low |
| Limits | per arm: time=unlimited, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited |
| Repetitions | 10 |
| Elapsed | 1h02m22s wall time |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

| Integrity field | Recorded value |
|---|---|
| Run hash (manifest tree sha256) | `aad228edb48a265a5791ddbe47c2b574350e504db5dd17d944c442e08be19c21` |
| Receipt manifest file sha256 | `40576bd0f9a411f289074b60eaadcf8c1001fb34a208b50088abd2150be3d2d7` |

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20261117T102715Z-70287a51/receipt.json --checks
```

## Export and comparable runs

### Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261117T102715Z-70287a51/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261117T102715Z-70287a51/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261117T102715Z-70287a51/receipt.json --to <output_dir> --pair r001
```

### Reproducibility

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model gemini-4-argon --thinking low --repetitions 10
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
