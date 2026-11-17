# Network configuration migration — Full evaluation report

| Run context | Recorded value |
|---|---|
| Case | `network-config-01` — network configuration migration |
| Run | `20261117T112937Z-ffe833a4` |
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
| Score | 58.5% | 90% | +31.5% |
| Cost: recorded tokens | 8,753,452 | 614,460 | −8,138,992 (−93.0%) |
| Latency | 665,278 ms | 189,899 ms | −475,379 ms (−71.5%) |

The overview displays the Score change as **+31.5%**, meaning an increase of **31.5 percentage points** (90% − 58.5%). This is the arithmetic score difference, not relative percentage growth. Token and latency changes retain their absolute and relative forms.

### Execution status

| Condition | Execution status | Grading |
|---|---|---|
| Baseline | Completed in all 10 pairs | All 10 graded |
| Treatment | Completed in all 10 pairs | All 10 graded |

### Score composition

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 38.5/80 — 48% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **58.5/100 — 59%** | **90/100 — 90%** |

### Outcome Checks

Mean points earned by each check across the pairs. Each row sums its frozen checks; a row shows `n/a` unless every pair has a verified result for it.

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 7.5/10 | 10/10 |
| Sequencer routing and submission policy | 1/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 9/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 1/10 | 10/10 |
| **Outcome total** | **38.5/80** | **70/80** |

### Cost and latency detail

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 8,753,452 | 614,460 |
| Time to completion or termination (ms) | 665,278 ms | 189,899 ms |

## Pair explorer

All pairs are graded. Open a pair for its full scoring and resource tables.

| Pair | Baseline Score | Treatment Score | Baseline status | Treatment status |
|---|---|---|---|---|
| [r001](#r001) | 55/100 — 55% | 90/100 — 90% | Completed | Completed |
| [r002](#r002) | 75/100 — 75% | 90/100 — 90% | Completed | Completed |
| [r003](#r003) | 55/100 — 55% | 90/100 — 90% | Completed | Completed |
| [r004](#r004) | 60/100 — 60% | 90/100 — 90% | Completed | Completed |
| [r005](#r005) | 55/100 — 55% | 90/100 — 90% | Completed | Completed |
| [r006](#r006) | 60/100 — 60% | 90/100 — 90% | Completed | Completed |
| [r007](#r007) | 55/100 — 55% | 90/100 — 90% | Completed | Completed |
| [r008](#r008) | 50/100 — 50% | 90/100 — 90% | Completed | Completed |
| [r009](#r009) | 65/100 — 65% | 90/100 — 90% | Completed | Completed |
| [r010](#r010) | 55/100 — 55% | 90/100 — 90% | Completed | Completed |

### r001

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r001`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 35/80 — 44% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **55/100 — 55%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **35/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 4,446,069 | 242,873 |
| Time to completion or termination (ms) | 497,298 ms | 128,410 ms |

</details>

### r002

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r002`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 55/80 — 69% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **75/100 — 75%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 10/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 5/10 | 10/10 |
| **Outcome total** | **55/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 3,649,555 | 276,114 |
| Time to completion or termination (ms) | 422,483 ms | 127,523 ms |

</details>

### r003

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r003`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 35/80 — 44% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **55/100 — 55%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **35/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 5,353,697 | 304,461 |
| Time to completion or termination (ms) | 698,510 ms | 196,993 ms |

</details>

### r004

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r004`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 40/80 — 50% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **60/100 — 60%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **40/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 7,301,802 | 474,223 |
| Time to completion or termination (ms) | 760,167 ms | 209,047 ms |

</details>

### r005

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r005`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 35/80 — 44% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **55/100 — 55%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **35/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 4,983,711 | 1,513,156 |
| Time to completion or termination (ms) | 634,744 ms | 156,049 ms |

</details>

### r006

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r006`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 40/80 — 50% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **60/100 — 60%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **40/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 38,494,685 | 1,246,331 |
| Time to completion or termination (ms) | 847,169 ms | 162,763 ms |

</details>

### r007

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r007`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 35/80 — 44% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **55/100 — 55%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **35/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 5,444,939 | 318,174 |
| Time to completion or termination (ms) | 584,635 ms | 149,289 ms |

</details>

### r008

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r008`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 30/80 — 38% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **50/100 — 50%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **30/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 7,126,753 | 722,960 |
| Time to completion or termination (ms) | 935,124 ms | 331,825 ms |

</details>

### r009

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r009`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 45/80 — 56% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **65/100 — 65%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 5/10 | 10/10 |
| **Outcome total** | **45/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 6,204,434 | 390,530 |
| Time to completion or termination (ms) | 723,943 ms | 176,153 ms |

</details>

### r010

<details>
<summary>Score, Outcome Checks, cost and latency</summary>

Pair ID: `20261117T112937Z-ffe833a4-r010`

Status: Baseline: completed, graded · Treatment: completed, graded

**Score composition**

| Check | Baseline | Treatment |
|---|---:|---:|
| Outcome correctness and completeness | 35/80 — 44% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Score total** | **55/100 — 55%** | **90/100 — 90%** |

**Outcome Checks**

| Check | Baseline | Treatment |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 5/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **35/80** | **70/80** |

**Cost and latency**

| Metric | Baseline | Treatment |
|---|---:|---:|
| Total recorded tokens, including cached input | 4,528,872 | 655,781 |
| Time to completion or termination (ms) | 548,709 ms | 260,937 ms |

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
| LLM model | Google Gemini 3.8 Flash |
| Registered model ID | `google/gemini-3.8-flash` |

| Execution / provenance field | Recorded value |
|---|---|
| Evaluator source revision | f1196bc72174268ec7d2aea0261433309497f182 (dirty working tree) |
| Evaluator build | evals-src@4a25be9cb0848d1d |
| Image digest(s) | sha256:690d42e7f07809075607282e6c81d6e4734ab6d124946887d5ec60ec4bb0787a |
| Skill snapshot tree sha256 | 6596dc2374114d6848489f46860ef0cc6959bb2ab936ca7d38ece5a638040d03 |
| SKILL.md sha256 | 21aa527276505c54eb6e84e5b35c64a848880116ba3f07449e1879f88b0d2339 |
| Provider | google |
| Model | gemini-3.8-flash |
| Thinking level | low |
| Limits | per arm: time=unlimited, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited |
| Repetitions | 10 |
| Elapsed | 1h53m11s wall time |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

| Integrity field | Recorded value |
|---|---|
| Run hash (manifest tree sha256) | `4489d036b9da449ab677ac403029d040d57b066831cb4c0c2796fcf85be0fa6c` |
| Receipt manifest file sha256 | `6a0ed67c3812874d88e86b5c2096ebc460ac6db47850311e65879b944f48166d` |

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20261117T112937Z-ffe833a4/receipt.json --checks
```

## Export and comparable runs

### Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261117T112937Z-ffe833a4/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261117T112937Z-ffe833a4/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261117T112937Z-ffe833a4/receipt.json --to <output_dir> --pair r001
```

### Reproducibility

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model gemini-3.8-flash --thinking low --repetitions 10
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
