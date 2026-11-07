# Network configuration migration — Full evaluation report

| Run context | Recorded value |
|---|---|
| Case | `network-config-01` — network configuration migration |
| Run | `20261106T144334Z-97b4ed31` |
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
| Score | 20% | 64% | +44% |
| Cost: recorded tokens | 899,838 | 274,804 | −625,034 (−69.5%) |
| Latency | 299,967 ms | 205,548 ms | −94,419 ms (−31.5%) |

The overview displays the Score change as **+44%**, meaning an increase of **44 percentage points** (64% − 20%). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.

### Execution status

| Condition | Execution status | Grading |
|---|---|---|
| Baseline | Task limit reached in all 10 pairs | All 10 graded |
| Treatment | Completed in 7 of 10 pairs; task limit reached in 3 | All 10 graded |

### Score composition

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 44/80 — 55% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **20/100 — 20%** | **64/100 — 64%** |

### Outcome Checks

Mean points earned by each check across the pairs. Each row sums its frozen checks; a row shows `n/a` unless every pair has a verified result for it.

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 0/10 | 7/10 |
| Legacy RPC fallback configuration | 0/10 | 7/10 |
| Public RPC and explorer endpoints | 0/10 | 7/10 |
| Sequencer routing and submission policy | 0/10 | 7/10 |
| WETH and USDC token identities | 0/10 | 7/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 2/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 7/10 |
| **Outcome total** | **0/80** | **44/80** |

### Cost and latency detail

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 899,838 | 274,804 |
| Time to completion or termination (ms) | 299,967 ms | 205,548 ms |

## Pair explorer

All pairs are graded. Open a pair for its full scoring and resource tables.

| Pair | Baseline Score | Treatment Score | Baseline status | Treatment status |
|---|---|---|---|---|
| [r001](#r001) | 20/100 — 20% | 80/100 — 80% | Task limit reached | Completed |
| [r002](#r002) | 20/100 — 20% | 80/100 — 80% | Task limit reached | Completed |
| [r003](#r003) | 20/100 — 20% | 80/100 — 80% | Task limit reached | Completed |
| [r004](#r004) | 20/100 — 20% | 80/100 — 80% | Task limit reached | Completed |
| [r005](#r005) | 20/100 — 20% | 20/100 — 20% | Task limit reached | Task limit reached |
| [r006](#r006) | 20/100 — 20% | 20/100 — 20% | Task limit reached | Task limit reached |
| [r007](#r007) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r008](#r008) | 20/100 — 20% | 20/100 — 20% | Task limit reached | Task limit reached |
| [r009](#r009) | 20/100 — 20% | 80/100 — 80% | Task limit reached | Completed |
| [r010](#r010) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |

### r001

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r001`

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
| Total recorded tokens, including cached input | 54,812 | 332,853 |
| Time to completion or termination (ms) | 299,581 ms | 222,168 ms |

</details>

### r002

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r002`

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
| Total recorded tokens, including cached input | 31,378 | 450,262 |
| Time to completion or termination (ms) | 299,720 ms | 226,434 ms |

</details>

### r003

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r003`

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
| Total recorded tokens, including cached input | 7,167,553 | 142,180 |
| Time to completion or termination (ms) | 299,618 ms | 76,179 ms |

</details>

### r004

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r004`

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
| Total recorded tokens, including cached input | 110,400 | 229,234 |
| Time to completion or termination (ms) | 299,961 ms | 155,426 ms |

</details>

### r005

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r005`

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
| Total recorded tokens, including cached input | 76,147 | 268,532 |
| Time to completion or termination (ms) | 300,048 ms | 299,906 ms |

</details>

### r006

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r006`

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
| Total recorded tokens, including cached input | 51,716 | 168,441 |
| Time to completion or termination (ms) | 300,170 ms | 299,998 ms |

</details>

### r007

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r007`

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
| Total recorded tokens, including cached input | 78,036 | 160,829 |
| Time to completion or termination (ms) | 300,299 ms | 94,244 ms |

</details>

### r008

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r008`

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
| Total recorded tokens, including cached input | 144,754 | 328,563 |
| Time to completion or termination (ms) | 300,489 ms | 300,360 ms |

</details>

### r009

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r009`

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
| Total recorded tokens, including cached input | 1,217,112 | 326,093 |
| Time to completion or termination (ms) | 300,186 ms | 235,514 ms |

</details>

### r010

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261106T144334Z-97b4ed31-r010`

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
| Total recorded tokens, including cached input | 66,469 | 341,054 |
| Time to completion or termination (ms) | 299,599 ms | 145,247 ms |

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
| Evaluator source revision | 8ad9c913889ba09190770697be7e1bd98b2f1b15 (dirty working tree) |
| Evaluator build | evals-src@8eb8b69fb2759d04 |
| Image digest(s) | sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0 |
| Skill snapshot tree sha256 | 469037a3080ad6e89c88442af559dce10f54f19faef7a81a57722f709137008c |
| SKILL.md sha256 | 4de1303417bff8a192fc95884d460041e3c0db88977701068e334b776dd57f01 |
| Provider | google |
| Model | gemini-3.8-flash |
| Thinking level | low |
| Limits | per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited |
| Repetitions | 10 |
| Elapsed | 52m41s wall time |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

| Integrity field | Recorded value |
|---|---|
| Run hash (manifest tree sha256) | `6cac43dfd4d7e29e4535ea0e7d9926f0f2c56c1fe5513a553df9b5c801d313af` |
| Receipt manifest file sha256 | `ed2a193178b3dceba81053e7ebde4fe062bbb51bc3d53da18aa8ad7c003880b8` |

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20261106T144334Z-97b4ed31/receipt.json --checks
```

## Export and comparable runs

### Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261106T144334Z-97b4ed31/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261106T144334Z-97b4ed31/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261106T144334Z-97b4ed31/receipt.json --to <output_dir> --pair r001
```

### Reproducibility

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model gemini-3.8-flash --thinking low --repetitions 10
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
