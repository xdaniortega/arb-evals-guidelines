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
Skill: arbitrum-docs  
Run: 20260924T151721Z-bfb34c20 · Pairs r001, r002, r003 · Hash: 9f885c24411ba4ce72cac7190feeffef77b2fe58b4bdc0ddef74828afe9abaac  
Status: Without this skill: task limit reached in 2 of 3 pairs, completed in 1, graded · With this skill: completed, graded

![AF-Evaluation: completed · 80%](https://img.shields.io/badge/AF--Evaluation-completed%20%C2%B7%2080%25-blue)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 40% | 80% | +40 percentage points |
| Cost: recorded tokens | 3,152,292 | 2,136,778 | −1,015,514 (−32.2%) |
| Latency | 298,395 ms | 235,438 ms | −62,957 ms (−21.1%) |

## Scenario: Migrate production and staging network configuration to Arbitrum

### Accuracy

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 20/80 — 25% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **40/100 — 40%** | **80/100 — 80%** |

### Accuracy Outcome Checks

Each check covers both production and staging.

| Check | Without this skill | With this skill |
|---|---:|---:|
| Correct network identities | 3.3/10 | 10/10 |
| Legacy RPC fallback configuration | 3.3/10 | 6.7/10 |
| Public RPC and explorer endpoints | 3.3/10 | 6.7/10 |
| Sequencer routing and submission policy | 0/10 | 6.7/10 |
| WETH and USDC token identities | 3.3/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 3.3/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 3.3/10 | 10/10 |
| **Outcome total** | **20/80** | **60/80** |

### Cost and latency

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 3,152,292 | 2,136,778 |
| Time to completion or termination (ms) | 298,395 ms | 235,438 ms |

## Per-pair results

### r001

Status: Without this skill: task limit reached, graded · With this skill: completed, graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **80/100 — 80%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 0/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **60/80** |

**Cost and latency**

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 58,858 | 2,715,722 |
| Time to completion or termination (ms) | 300,530 ms | 270,809 ms |

### r002

Status: Without this skill: task limit reached, graded · With this skill: completed, graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **80/100 — 80%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
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

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 5,741,732 | 502,216 |
| Time to completion or termination (ms) | 300,271 ms | 149,745 ms |

### r003

Status: Completed; graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 60/80 — 75% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **80/100 — 80%** | **80/100 — 80%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Correct network identities | 10/10 | 10/10 |
| Legacy RPC fallback configuration | 10/10 | 0/10 |
| Public RPC and explorer endpoints | 10/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 10/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 10/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 10/10 | 10/10 |
| **Outcome total** | **60/80** | **60/80** |

**Cost and latency**

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 3,656,286 | 3,192,397 |
| Time to completion or termination (ms) | 294,385 ms | 285,761 ms |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

Run hash (manifest tree sha256): 9f885c24411ba4ce72cac7190feeffef77b2fe58b4bdc0ddef74828afe9abaac  
Receipt manifest file sha256: 5acf764520966c4427aab001b2050f76800792cc22e214562c05039b8171666c

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20260924T151721Z-bfb34c20/receipt.json --checks
```

## Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20260924T151721Z-bfb34c20/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20260924T151721Z-bfb34c20/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20260924T151721Z-bfb34c20/receipt.json --to <output_dir> --pair r001
```

## Operational details

- Limits: per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited
- Elapsed: 15m39s wall time

```text
pair 20260924T151721Z-bfb34c20-r001 (repetition 1)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=300530 providerRequests=12 toolSteps=11 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:7ddcbfe3.message.content[0].text)
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t151721zbfb34c20-r001-baseline-7d69671a=destroyed (verified), network:eval-net-20260924t151721zbfb34c20-r001-baseline-7d69671a=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.800  checks=14/18 skillPaths=1 durationMs=270809 providerRequests=33 toolSteps=32
             stopCause=completed providerStop=STOP
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t151721zbfb34c20-r001-treatment-7d69671a=destroyed (verified), network:eval-net-20260924t151721zbfb34c20-r001-treatment-7d69671a=destroyed (verified)
  delta     +0.600  (both conditions graded)
pair 20260924T151721Z-bfb34c20-r002 (repetition 2)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=300271 providerRequests=93 toolSteps=92 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:d3a6fb15.message.content[0].text)
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t151721zbfb34c20-r002-baseline-7d69671a=destroyed (verified), network:eval-net-20260924t151721zbfb34c20-r002-baseline-7d69671a=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.800  checks=14/18 skillPaths=1 durationMs=149745 providerRequests=21 toolSteps=20
             stopCause=completed providerStop=STOP
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t151721zbfb34c20-r002-treatment-7d69671a=destroyed (verified), network:eval-net-20260924t151721zbfb34c20-r002-treatment-7d69671a=destroyed (verified)
  delta     +0.600  (both conditions graded)
pair 20260924T151721Z-bfb34c20-r003 (repetition 3)
  baseline  status=completed              gradeable=true  score=0.800  checks=14/18 skillPaths=0 durationMs=294385 providerRequests=112 toolSteps=110 redactions=1
             stopCause=completed providerStop=STOP
             redactions=1 (session:8fd5a0dc.message.content[0].text)
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t151721zbfb34c20-r003-baseline-7d69671a=destroyed (verified), network:eval-net-20260924t151721zbfb34c20-r003-baseline-7d69671a=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.800  checks=14/18 skillPaths=1 durationMs=285761 providerRequests=41 toolSteps=39
             stopCause=completed providerStop=STOP
             image=sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
             cleanup=guest:eval-guest-20260924t151721zbfb34c20-r003-treatment-7d69671a=destroyed (verified), network:eval-net-20260924t151721zbfb34c20-r003-treatment-7d69671a=destroyed (verified)
  delta     0.000  (both conditions graded)
```

## Reproducibility

Recorded facts:

- Evaluator source revision: 0dfc1236a839d5239108fc72726ef5c7dd90c4c9 (dirty working tree)
- Evaluator build: evals-src@0f9e04f3eb5a0d62
- Image digest(s): sha256:69ce52a15237c05be727a088f01102596e4fc0122d69741fd8d6412fbbdc193a
- Skill snapshot tree sha256: 3bb62abfba04c414e793492ccda84aef53faf9e1a18578767065b8cbfb361fce
- SKILL.md sha256: 7852efd9b25bc5d607396a9f39e8d422ec7cbe1dc6dbdec7c8cfd87d70264e46
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
