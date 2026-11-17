# Network configuration migration — Full evaluation report

| Run context | Recorded value |
|---|---|
| Case | `network-config-01` — network configuration migration |
| Run | `20261108T093450Z-392b231d` |
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
| Score | 60.5% | 90% | +29.5% |
| Cost: recorded tokens | 42,015 | 56,468 | +14,453 (+34.4%) |
| Latency | 222,325 ms | 140,631 ms | −81,694 ms (−36.7%) |

The overview displays the Score change as **+29.5%**, meaning an increase of **29.5 percentage points** (90% − 60.5%). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.

### Execution status

| Condition | Execution status | Grading |
|---|---|---|
| Baseline | Completed in 7 of 10 pairs; task limit reached in 3 | All 10 graded |
| Treatment | Completed in all 10 pairs | All 10 graded |

### Score composition

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 48.5/80 — 61% | 70/80 — 88% |
| Constraints and preservation | 12/20 — 60% | 20/20 — 100% |
| **Score total** | **60.5/100 — 61%** | **90/100 — 90%** |

### Outcome Checks

Mean points earned by each check across the pairs. Each row sums its frozen checks; a row shows `n/a` unless every pair has a verified result for it.

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 9/10 | 10/10 |
| Legacy RPC fallback configuration | 9/10 | 10/10 |
| Public RPC and explorer endpoints | 7/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 9/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 9/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 5.5/10 | 10/10 |
| **Outcome total** | **48.5/80** | **70/80** |

### Cost and latency detail

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 42,015 | 56,468 |
| Time to completion or termination (ms) | 222,325 ms | 140,631 ms |

## Pair explorer

All pairs are graded. Open a pair for its full scoring and resource tables.

| Pair | Baseline Score | Treatment Score | Baseline status | Treatment status |
|---|---|---|---|---|
| [r001](#r001) | 65/100 — 65% | 90/100 — 90% | Task limit reached | Completed |
| [r002](#r002) | 70/100 — 70% | 90/100 — 90% | Completed | Completed |
| [r003](#r003) | 65/100 — 65% | 90/100 — 90% | Completed | Completed |
| [r004](#r004) | 55/100 — 55% | 90/100 — 90% | Completed | Completed |
| [r005](#r005) | 60/100 — 60% | 90/100 — 90% | Completed | Completed |
| [r006](#r006) | 20/100 — 20% | 90/100 — 90% | Task limit reached | Completed |
| [r007](#r007) | 80/100 — 80% | 90/100 — 90% | Completed | Completed |
| [r008](#r008) | 70/100 — 70% | 90/100 — 90% | Completed | Completed |
| [r009](#r009) | 60/100 — 60% | 90/100 — 90% | Completed | Completed |
| [r010](#r010) | 60/100 — 60% | 90/100 — 90% | Task limit reached | Completed |

### r001

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r001`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

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
| Total recorded tokens, including cached input | 33,373 | 54,924 |
| Time to completion or termination (ms) | 299,606 ms | 112,437 ms |

</details>

### r002

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r002`

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
| Total recorded tokens, including cached input | 29,554 | 55,080 |
| Time to completion or termination (ms) | 221,502 ms | 154,774 ms |

</details>

### r003

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r003`

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
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 10/10 | 10/10 |
| **Outcome total** | **55/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 33,398 | 55,062 |
| Time to completion or termination (ms) | 139,019 ms | 263,907 ms |

</details>

### r004

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r004`

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
| Public RPC and explorer endpoints | 0/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 5/10 | 10/10 |
| **Outcome total** | **45/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 38,636 | 55,019 |
| Time to completion or termination (ms) | 232,279 ms | 126,669 ms |

</details>

### r005

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r005`

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
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 5/10 | 10/10 |
| **Outcome total** | **50/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 64,357 | 49,415 |
| Time to completion or termination (ms) | 268,803 ms | 149,002 ms |

</details>

### r006

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r006`

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
| Total recorded tokens, including cached input | 79,893 | 55,034 |
| Time to completion or termination (ms) | 299,819 ms | 109,629 ms |

</details>

### r007

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r007`

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
| Total recorded tokens, including cached input | 44,688 | 74,653 |
| Time to completion or termination (ms) | 176,851 ms | 118,655 ms |

</details>

### r008

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r008`

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
| Total recorded tokens, including cached input | 41,412 | 55,057 |
| Time to completion or termination (ms) | 115,563 ms | 141,305 ms |

</details>

### r009

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r009`

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
| Total recorded tokens, including cached input | 39,006 | 55,059 |
| Time to completion or termination (ms) | 169,880 ms | 105,108 ms |

</details>

### r010

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261108T093450Z-392b231d-r010`

Status: Baseline: task limit reached, graded · Treatment: completed, graded

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
| Total recorded tokens, including cached input | 15,836 | 55,378 |
| Time to completion or termination (ms) | 299,930 ms | 124,821 ms |

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
| Evaluator source revision | 4fceaa42ee03124d3e42cb8dee454bb8866a7e2c (dirty working tree) |
| Evaluator build | evals-src@480b135281b0e59d |
| Image digest(s) | sha256:690d42e7f07809075607282e6c81d6e4734ab6d124946887d5ec60ec4bb0787a |
| Skill snapshot tree sha256 | def5c7a2c8b23292b1e2953d1841f473782356c0040345a9861dd43902dc0fea |
| SKILL.md sha256 | 0b1218121916231897cc64df6c17e901c568e7cf06ee0245e742c9ec608c2169 |
| Provider | google |
| Model | gemini-4-argon |
| Thinking level | low |
| Limits | per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited |
| Repetitions | 10 |
| Elapsed | 42m29s wall time |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

| Integrity field | Recorded value |
|---|---|
| Run hash (manifest tree sha256) | `d74c1490c2c475ecc5bdbc8255f6096f346943e1538a707a941efdfd64d51150` |
| Receipt manifest file sha256 | `4cb70b3ebb9a4d35585446a550828075fed073c81dc398bc9b7aa53784c569b6` |

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20261108T093450Z-392b231d/receipt.json --checks
```

## Export and comparable runs

### Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261108T093450Z-392b231d/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261108T093450Z-392b231d/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261108T093450Z-392b231d/receipt.json --to <output_dir> --pair r001
```

### Reproducibility

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model gemini-4-argon --thinking low --repetitions 10
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
