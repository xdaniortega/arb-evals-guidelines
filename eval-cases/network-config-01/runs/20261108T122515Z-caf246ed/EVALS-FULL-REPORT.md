# Network configuration migration — Full evaluation report

| Run context | Recorded value |
|---|---|
| Case | `network-config-01` — network configuration migration |
| Run | `20261108T122515Z-caf246ed` |
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
| Score | 20% | 76% | +56% |
| Cost: recorded tokens | 1,049,065 | 415,779 | −633,286 (−60.4%) |
| Latency | 299,887 ms | 162,744 ms | −137,143 ms (−45.7%) |

The overview displays the Score change as **+56%**, meaning an increase of **56 percentage points** (76% − 20%). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.

### Execution status

| Condition | Execution status | Grading |
|---|---|---|
| Baseline | Task limit reached in all 10 pairs | All 10 graded |
| Treatment | Completed in 9 of 10 pairs; task limit reached in 1 | All 10 graded |

### Score composition

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 56/80 — 70% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **76/100 — 76%** |

### Outcome Checks

Mean points earned by each check across the pairs. Each row sums its frozen checks; a row shows `n/a` unless every pair has a verified result for it.

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 8/10 |
| Legacy RPC fallback configuration | 0/10 | 8/10 |
| Public RPC and explorer endpoints | 0/10 | 8/10 |
| Sequencer routing and submission policy | 0/10 | 8/10 |
| WETH and USDC token identities | 0/10 | 8/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 8/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 8/10 |
| **Outcome total** | **0/80** | **56/80** |

### Cost and latency detail

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 1,049,065 | 415,779 |
| Time to completion or termination (ms) | 299,887 ms | 162,744 ms |

## Pair explorer

All pairs are graded. Open a pair for its full scoring and resource tables.

| Pair | Baseline Score | Treatment Score | Baseline status | Treatment status |
|---|---|---|---|---|
| [r001](#r001) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r002](#r002) | 20/100 — 20% | 20/100 — 20% | Task limit reached | Task limit reached |
| [r003](#r003) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r004](#r004) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r005](#r005) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r006](#r006) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r007](#r007) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r008](#r008) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r009](#r009) | 20/100 — 20% | 20/100 — 20% | Task limit reached | Completed |
| [r010](#r010) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |

### r001

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r001`

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
| Total recorded tokens, including cached input | 810,939 | 277,016 |
| Time to completion or termination (ms) | 299,789 ms | 157,101 ms |

</details>

### r002

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r002`

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
| Total recorded tokens, including cached input | 864,583 | 1,970,815 |
| Time to completion or termination (ms) | 299,980 ms | 299,843 ms |

</details>

### r003

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r003`

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
| Total recorded tokens, including cached input | 1,148,472 | 313,711 |
| Time to completion or termination (ms) | 299,819 ms | 170,788 ms |

</details>

### r004

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r004`

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
| Total recorded tokens, including cached input | 1,218,701 | 176,045 |
| Time to completion or termination (ms) | 299,572 ms | 111,258 ms |

</details>

### r005

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r005`

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
| Total recorded tokens, including cached input | 1,137,965 | 302,715 |
| Time to completion or termination (ms) | 299,704 ms | 205,014 ms |

</details>

### r006

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r006`

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
| Total recorded tokens, including cached input | 1,123,128 | 442,094 |
| Time to completion or termination (ms) | 299,679 ms | 210,026 ms |

</details>

### r007

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r007`

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
| Total recorded tokens, including cached input | 1,368,588 | 214,065 |
| Time to completion or termination (ms) | 299,686 ms | 138,836 ms |

</details>

### r008

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r008`

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
| Total recorded tokens, including cached input | 1,118,597 | 168,351 |
| Time to completion or termination (ms) | 299,988 ms | 164,937 ms |

</details>

### r009

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r009`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

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
| Total recorded tokens, including cached input | 1,056,360 | 31,005 |
| Time to completion or termination (ms) | 300,187 ms | 16,749 ms |

</details>

### r010

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T122515Z-caf246ed-r010`

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
| Total recorded tokens, including cached input | 643,316 | 261,973 |
| Time to completion or termination (ms) | 300,466 ms | 152,885 ms |

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
| LLM model | Google Gemini 3.8 Flash |
| Registered model ID | `google/gemini-3.8-flash` |

| Execution / provenance field | Recorded value |
|---|---|
| Evaluator source revision | 4fceaa42ee03124d3e42cb8dee454bb8866a7e2c (dirty working tree) |
| Evaluator build | evals-src@0a2a45dcc1cd75d3 |
| Image digest(s) | sha256:690d42e7f07809075607282e6c81d6e4734ab6d124946887d5ec60ec4bb0787a |
| Skill snapshot tree sha256 | def5c7a2c8b23292b1e2953d1841f473782356c0040345a9861dd43902dc0fea |
| SKILL.md sha256 | 0b1218121916231897cc64df6c17e901c568e7cf06ee0245e742c9ec608c2169 |
| Provider | google |
| Model | gemini-3.8-flash |
| Thinking level | low |
| Limits | per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited |
| Repetitions | 10 |
| Elapsed | 52m55s wall time |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

| Integrity field | Recorded value |
|---|---|
| Run hash (manifest tree sha256) | `2a79367788819a66f6e3a4a21746e0c5af8e8b6f194dbc0289d46889cfd0977f` |
| Receipt manifest file sha256 | `453a9299c6ebfc8d7ebeee532c5b04efce6fdff91df62ae818794740c35b8a39` |

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20261108T122515Z-caf246ed/receipt.json --checks
```

## Export and comparable runs

### Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261108T122515Z-caf246ed/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261108T122515Z-caf246ed/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261108T122515Z-caf246ed/receipt.json --to <output_dir> --pair r001
```

### Reproducibility

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model gemini-3.8-flash --thinking low --repetitions 10
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
