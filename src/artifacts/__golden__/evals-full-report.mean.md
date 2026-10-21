> **Warning:** TEST-DOUBLE EVIDENCE — synthetic scores, not a measured result

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

Agent: fake · google/fake-model-0  
Skill: mcp-skill  
Run: 19700101T000000Z-abcdef12 · Pairs r001, r002, r003 · Hash: <sha256>  
Status: Completed; graded

![AF-Evaluation: completed · 20%](https://img.shields.io/badge/AF--Evaluation-completed%20%C2%B7%2020%25-blue)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 20% | 20% | 0 percentage points |
| Cost: recorded tokens | n/a | n/a | n/a |
| Latency | 0 ms | 0 ms | 0 ms (n/a) |

## Scenario: Migrate production and staging network configuration to Arbitrum

### Accuracy

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 0/80 — 0% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **20/100 — 20%** |

### Accuracy Outcome Checks

Each check covers both production and staging.

| Check | Without this skill | With this skill |
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

### Cost and latency

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | n/a | n/a |
| Time to completion or termination (ms) | 0 ms | 0 ms |

## Per-pair results

### r001

Status: Completed; graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 0/80 — 0% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **20/100 — 20%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
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

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | n/a | n/a |
| Time to completion or termination (ms) | 0 ms | 0 ms |

### r002

Status: Completed; graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 0/80 — 0% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **20/100 — 20%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
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

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | n/a | n/a |
| Time to completion or termination (ms) | 0 ms | 0 ms |

### r003

Status: Completed; graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 0/80 — 0% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **20/100 — 20%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
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

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | n/a | n/a |
| Time to completion or termination (ms) | 0 ms | 0 ms |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

Run hash (manifest tree sha256): <sha256>  
Receipt manifest file sha256: <sha256>

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/19700101T000000Z-abcdef12/receipt.json --checks
```

## Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/19700101T000000Z-abcdef12/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/19700101T000000Z-abcdef12/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/19700101T000000Z-abcdef12/receipt.json --to <output_dir> --pair r001
```

## Operational details

- Limits: per arm: time=unlimited, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited
- Elapsed: <elapsed>

```text
pair 19700101T000000Z-abcdef12-r001 (repetition 1)
  baseline  status=completed              gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=<ms> providerRequests=0 toolSteps=0
             stopCause=completed
             image=sha256:<sha256>
             cleanup=guest:eval-guest-19700101t000000zabcdef12-r001-baseline-0a1b2c3d=destroyed (verified), network:eval-net-19700101t000000zabcdef12-r001-baseline-0a1b2c3d=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.200  checks=2/18 skillPaths=1 durationMs=<ms> providerRequests=0 toolSteps=0
             stopCause=completed
             image=sha256:<sha256>
             cleanup=guest:eval-guest-19700101t000000zabcdef12-r001-treatment-0a1b2c3d=destroyed (verified), network:eval-net-19700101t000000zabcdef12-r001-treatment-0a1b2c3d=destroyed (verified)
  delta     0.000  (both conditions graded)
pair 19700101T000000Z-abcdef12-r002 (repetition 2)
  baseline  status=completed              gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=<ms> providerRequests=0 toolSteps=0
             stopCause=completed
             image=sha256:<sha256>
             cleanup=guest:eval-guest-19700101t000000zabcdef12-r002-baseline-0a1b2c3d=destroyed (verified), network:eval-net-19700101t000000zabcdef12-r002-baseline-0a1b2c3d=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.200  checks=2/18 skillPaths=1 durationMs=<ms> providerRequests=0 toolSteps=0
             stopCause=completed
             image=sha256:<sha256>
             cleanup=guest:eval-guest-19700101t000000zabcdef12-r002-treatment-0a1b2c3d=destroyed (verified), network:eval-net-19700101t000000zabcdef12-r002-treatment-0a1b2c3d=destroyed (verified)
  delta     0.000  (both conditions graded)
pair 19700101T000000Z-abcdef12-r003 (repetition 3)
  baseline  status=completed              gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=<ms> providerRequests=0 toolSteps=0
             stopCause=completed
             image=sha256:<sha256>
             cleanup=guest:eval-guest-19700101t000000zabcdef12-r003-baseline-0a1b2c3d=destroyed (verified), network:eval-net-19700101t000000zabcdef12-r003-baseline-0a1b2c3d=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.200  checks=2/18 skillPaths=1 durationMs=<ms> providerRequests=0 toolSteps=0
             stopCause=completed
             image=sha256:<sha256>
             cleanup=guest:eval-guest-19700101t000000zabcdef12-r003-treatment-0a1b2c3d=destroyed (verified), network:eval-net-19700101t000000zabcdef12-r003-treatment-0a1b2c3d=destroyed (verified)
  delta     0.000  (both conditions graded)
```

## Reproducibility

Recorded facts:

- Evaluator source revision: 0000000000000000000000000000000000000000 (clean)
- Evaluator build: evals-src@test
- Image digest(s): sha256:<sha256>
- Skill snapshot tree sha256: <sha256>
- SKILL.md sha256: <sha256>
- Provider: google
- Model: fake-model-0
- Thinking level: off
- Limits: per arm: time=unlimited, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited
- Repetitions: 3

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model fake-model-0 --thinking off --repetitions 3
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
