# EVALS-FULL-REPORT: network configuration migration

## About this case

- Case: network-config-01, version 10
- Rubric version: v0.2
- Allowed tools: read, bash, edit, write, grep, find, ls
- Output path: config.json

Prompt (verbatim):

```text
Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.
```

Checks:

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

[Current case documentation](../../README.md); the frozen inputs above are authoritative. This section is explanatory only and is not evidence.

Agent: Pi · google/gemini-3.8-flash  
Skill: arbitrum-network  
Run: 20260924T170734Z-b115674e · Pairs r001, r002, r003 · Hash: 6897ffb3af741c6e4bba6f9ad6c7f18ea0cdddebfb4b616cc87dd3fbbea7eef5  
Status: Without this skill: completed in 2 of 3 pairs, task limit reached in 1, graded · With this skill: completed, graded

![AF-Evaluation: completed · 80%](https://img.shields.io/badge/AF--Evaluation-completed%20%C2%B7%2080%25-blue)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 48.3% | 80% | +31.7 percentage points |
| Cost: recorded tokens | 5,473,447 | 104,124 | −5,369,323 (−98.1%) |
| Latency | 190,561 ms | 33,922 ms | −156,639 ms (−82.2%) |

## Scenario: Migrate production and staging network configuration to Arbitrum

### Accuracy

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 28.3/80 — 35% | 66.7/80 — 83% |
| Constraints and preservation | 20/20 — 100% | 13.3/20 — 67% |
| **Accuracy total** | **48.3/100 — 48%** | **80/100 — 80%** |

### Accuracy Outcome Checks

Each check covers both production and staging.

| Check | Without this skill | With this skill |
|---|---:|---:|
| Correct network identities | 6.7/10 | 10/10 |
| Legacy RPC fallback configuration | 6.7/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 3.3/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 6.7/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 3.3/10 |
| Bridge onboarding configuration | 6.7/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 1.7/10 | 10/10 |
| **Outcome total** | **28.3/80** | **66.7/80** |

### Cost and latency

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 5,473,447 | 104,124 |
| Time to completion or termination (ms) | 190,561 ms | 33,922 ms |

## Per-pair results

### r001

Status: Completed; graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 45/80 — 56% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **65/100 — 65%** | **90/100 — 90%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
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

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 79,819 | 108,891 |
| Time to completion or termination (ms) | 22,700 ms | 33,026 ms |

### r002

Status: Completed; graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 40/80 — 50% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 10/20 — 50% |
| **Accuracy total** | **60/100 — 60%** | **70/100 — 70%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **40/80** | **60/80** |

**Cost and latency**

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 7,421,005 | 100,925 |
| Time to completion or termination (ms) | 248,583 ms | 39,701 ms |

### r003

Status: Without this skill: task limit reached, graded · With this skill: completed, graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 10/20 — 50% |
| **Accuracy total** | **20/100 — 20%** | **80/100 — 80%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 10/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **70/80** |

**Cost and latency**

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 8,919,516 | 102,555 |
| Time to completion or termination (ms) | 300,400 ms | 29,039 ms |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

Run hash (manifest tree sha256): 6897ffb3af741c6e4bba6f9ad6c7f18ea0cdddebfb4b616cc87dd3fbbea7eef5  
Receipt manifest file sha256: 4dd373179ed3f5223e55997569ee32dd3ccc9853ac0e49147b1d8931b5d6b4f5

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20260924T170734Z-b115674e/receipt.json --checks
```

## Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20260924T170734Z-b115674e/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20260924T170734Z-b115674e/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20260924T170734Z-b115674e/receipt.json --to <output_dir> --pair r001
```

## Operational details

- Limits: per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited
- Elapsed: 10m28s wall time

```text
pair 20260924T170734Z-b115674e-r001 (repetition 1)
  baseline  status=completed              gradeable=true  score=0.650  checks=11/18 skillPaths=0 durationMs=22700 providerRequests=14 toolSteps=13 redactions=1
             stopCause=completed providerStop=STOP
             redactions=1 (session:9411838a.message.content[0].text)
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t170734zb115674e-r001-baseline-821643a0=destroyed (verified), network:eval-net-20260924t170734zb115674e-r001-baseline-821643a0=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.900  checks=16/18 skillPaths=1 durationMs=33026 providerRequests=12 toolSteps=11
             stopCause=completed providerStop=STOP
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t170734zb115674e-r001-treatment-821643a0=destroyed (verified), network:eval-net-20260924t170734zb115674e-r001-treatment-821643a0=destroyed (verified)
  delta     +0.250  (both conditions graded)
pair 20260924T170734Z-b115674e-r002 (repetition 2)
  baseline  status=completed              gradeable=true  score=0.600  checks=10/18 skillPaths=0 durationMs=248583 providerRequests=115 toolSteps=114 redactions=1
             stopCause=completed providerStop=STOP
             redactions=1 (session:10e36786.message.content[0].text)
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t170734zb115674e-r002-baseline-821643a0=destroyed (verified), network:eval-net-20260924t170734zb115674e-r002-baseline-821643a0=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.700  checks=13/18 skillPaths=1 durationMs=39701 providerRequests=12 toolSteps=11
             stopCause=completed providerStop=STOP
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t170734zb115674e-r002-treatment-821643a0=destroyed (verified), network:eval-net-20260924t170734zb115674e-r002-treatment-821643a0=destroyed (verified)
  delta     +0.100  (both conditions graded)
pair 20260924T170734Z-b115674e-r003 (repetition 3)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=300400 providerRequests=153 toolSteps=152 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:da491333.message.content[0].text)
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t170734zb115674e-r003-baseline-821643a0=destroyed (verified), network:eval-net-20260924t170734zb115674e-r003-baseline-821643a0=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.800  checks=15/18 skillPaths=1 durationMs=29039 providerRequests=12 toolSteps=11
             stopCause=completed providerStop=STOP
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t170734zb115674e-r003-treatment-821643a0=destroyed (verified), network:eval-net-20260924t170734zb115674e-r003-treatment-821643a0=destroyed (verified)
  delta     +0.600  (both conditions graded)
```

## Reproducibility

Recorded facts:

- Evaluator source revision: 0dfc1236a839d5239108fc72726ef5c7dd90c4c9 (dirty working tree)
- Evaluator build: evals-src@9011277422f57f1c
- Image digest(s): sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
- Skill snapshot tree sha256: 8d75d73271793bb61d9bf2334f6a2ce480c5d60a1f0f09a5019683cec6f0b853
- SKILL.md sha256: 5af35aa3611778d0b3dcdbfc097a745994f39e797858883b65096fed5ceb98f5
- Provider: google
- Model: gemini-3.8-flash
- Thinking level: low
- Limits: per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited
- Repetitions: 3

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model gemini-3.8-flash --thinking low --repetitions 3
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
