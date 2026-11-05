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
Run: 20261105T124949Z-cfc819ba · Pairs r001, r002, r003, r004, r005, r006, r007, r008, r009, r010 · Hash: 0fd51ed151b308982b3dea28e77fdd3ffdff4c6266b82b3dd16a4026aa16d171  
Status: Without this skill: task limit reached, graded · With this skill: completed in 8 of 10 pairs, task limit reached in 2, graded

![AF-Evaluation: mixed · 69%](https://img.shields.io/badge/AF--Evaluation-mixed%20%C2%B7%2069%25-yellow)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 20% | 69% | +49 percentage points |
| Cost: recorded tokens | 698,606 | 173,219 | −525,387 (−75.2%) |
| Latency | 300,012 ms | 133,444 ms | −166,568 ms (−55.5%) |

## Scenario: Migrate production and staging network configuration to Arbitrum

### Accuracy

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 50/80 — 63% |
| Constraints and preservation | 20/20 — 100% | 19/20 — 95% |
| **Accuracy total** | **20/100 — 20%** | **69/100 — 69%** |

### Accuracy Outcome Checks

Each check covers both production and staging.

| Check | Without this skill | With this skill |
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

### Cost and latency

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 698,606 | 173,219 |
| Time to completion or termination (ms) | 300,012 ms | 133,444 ms |

## Per-pair results

### r001

Status: Without this skill: task limit reached, graded · With this skill: completed, graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 50/80 — 63% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **70/100 — 70%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
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

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 1,928,374 | 165,014 |
| Time to completion or termination (ms) | 300,295 ms | 72,603 ms |

### r002

Status: Without this skill: task limit reached, graded · With this skill: completed, graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 10/20 — 50% |
| **Accuracy total** | **20/100 — 20%** | **70/100 — 70%** |

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
| Total recorded tokens, including cached input | 1,932,547 | 106,040 |
| Time to completion or termination (ms) | 300,203 ms | 67,949 ms |

### r003

Status: Without this skill: task limit reached, graded · With this skill: completed, graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **90/100 — 90%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
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

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 895,764 | 81,011 |
| Time to completion or termination (ms) | 300,046 ms | 52,213 ms |

### r004

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
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **60/80** |

**Cost and latency**

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 100,537 | 338,553 |
| Time to completion or termination (ms) | 299,623 ms | 231,250 ms |

### r005

Status: Task limit reached; graded

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
| Total recorded tokens, including cached input | 39,838 | 335,943 |
| Time to completion or termination (ms) | 299,892 ms | 299,748 ms |

### r006

Status: Without this skill: task limit reached, graded · With this skill: completed, graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **90/100 — 90%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
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

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 39,964 | 197,297 |
| Time to completion or termination (ms) | 300,164 ms | 106,134 ms |

### r007

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
| Total recorded tokens, including cached input | 51,960 | 129,450 |
| Time to completion or termination (ms) | 300,134 ms | 80,035 ms |

### r008

Status: Task limit reached; graded

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
| Total recorded tokens, including cached input | 635,474 | 180,932 |
| Time to completion or termination (ms) | 299,779 ms | 299,671 ms |

### r009

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
| Total recorded tokens, including cached input | 1,338,848 | 130,514 |
| Time to completion or termination (ms) | 299,618 ms | 81,733 ms |

### r010

Status: Without this skill: task limit reached, graded · With this skill: completed, graded

**Accuracy**

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 0/80 — 0% | 70/80 — 88% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **90/100 — 90%** |

**Accuracy Outcome Checks**

| Check | Without this skill | With this skill |
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

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 22,753 | 67,434 |
| Time to completion or termination (ms) | 300,370 ms | 43,103 ms |

## Verify this report

This file is generated and is not part of the sealed hash chain. It is tied to its run by the hashes below, which come from `receipt.json`.

Run hash (manifest tree sha256): 0fd51ed151b308982b3dea28e77fdd3ffdff4c6266b82b3dd16a4026aa16d171  
Receipt manifest file sha256: 93ce07af0fc930aefec8cb60b28a8fa13d74b2a6c479a53c01c16097cad2a9af

Recompute the evidence chain and compare the tree hash it prints with the one above:

```text
pnpm eval:report -- --receipt eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/receipt.json --checks
```

## Export

The first command (re)generates `EVALS.md` and `EVALS-FULL-REPORT.md` inside this run folder. `--to` additionally copies the summary into a directory. **`EVALS.md` is the file to export or copy into the skills repository.** `EVALS-FULL-REPORT.md` stays in this repository.

```text
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/receipt.json
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/receipt.json --to <output_dir>
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/receipt.json --to <output_dir> --pair r001
```

## Operational details

- Limits: per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited
- Elapsed: 52m36s wall time

```text
pair 20261105T124949Z-cfc819ba-r001 (repetition 1)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=300295 providerRequests=44 toolSteps=43 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:334eabcd.message.content[0].text)
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r001-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r001-baseline-338af700=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.700  checks=12/18 skillPaths=1 durationMs=72603 providerRequests=16 toolSteps=15
             stopCause=completed providerStop=STOP
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r001-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r001-treatment-338af700=destroyed (verified)
  delta     +0.500  (both conditions graded)
pair 20261105T124949Z-cfc819ba-r002 (repetition 2)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=300203 providerRequests=46 toolSteps=45 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:e7d7d0e4.message.content[0].text)
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r002-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r002-baseline-338af700=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.700  checks=13/18 skillPaths=1 durationMs=67949 providerRequests=12 toolSteps=11
             stopCause=completed providerStop=STOP
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r002-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r002-treatment-338af700=destroyed (verified)
  delta     +0.500  (both conditions graded)
pair 20261105T124949Z-cfc819ba-r003 (repetition 3)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=300046 providerRequests=48 toolSteps=47 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:40138c73.message.content[0].text)
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r003-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r003-baseline-338af700=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.900  checks=16/18 skillPaths=1 durationMs=52213 providerRequests=8 toolSteps=10
             stopCause=completed providerStop=STOP
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r003-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r003-treatment-338af700=destroyed (verified)
  delta     +0.700  (both conditions graded)
pair 20261105T124949Z-cfc819ba-r004 (repetition 4)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=299623 providerRequests=19 toolSteps=18 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:fc180aee.message.content[0].text)
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r004-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r004-baseline-338af700=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.800  checks=14/18 skillPaths=1 durationMs=231250 providerRequests=14 toolSteps=15
             stopCause=completed providerStop=STOP
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r004-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r004-treatment-338af700=destroyed (verified)
  delta     +0.600  (both conditions graded)
pair 20261105T124949Z-cfc819ba-r005 (repetition 5)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=299892 providerRequests=9 toolSteps=8
             stopCause=wall-clock providerStop=aborted
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r005-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r005-baseline-338af700=destroyed (verified)
  treatment status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=1 durationMs=299748 providerRequests=25 toolSteps=26
             stopCause=wall-clock providerStop=aborted
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r005-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r005-treatment-338af700=destroyed (verified)
  delta     0.000  (both conditions graded)
pair 20261105T124949Z-cfc819ba-r006 (repetition 6)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=300164 providerRequests=10 toolSteps=9 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:9bec9934.message.content[0].text)
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r006-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r006-baseline-338af700=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.900  checks=16/18 skillPaths=1 durationMs=106134 providerRequests=20 toolSteps=19
             stopCause=completed providerStop=STOP
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r006-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r006-treatment-338af700=destroyed (verified)
  delta     +0.700  (both conditions graded)
pair 20261105T124949Z-cfc819ba-r007 (repetition 7)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=300134 providerRequests=13 toolSteps=12 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:7d19c620.message.content[0].text)
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r007-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r007-baseline-338af700=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.800  checks=14/18 skillPaths=1 durationMs=80035 providerRequests=14 toolSteps=13
             stopCause=completed providerStop=STOP
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r007-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r007-treatment-338af700=destroyed (verified)
  delta     +0.600  (both conditions graded)
pair 20261105T124949Z-cfc819ba-r008 (repetition 8)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=299779 providerRequests=46 toolSteps=45 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:9e7b8693.message.content[0].text)
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r008-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r008-baseline-338af700=destroyed (verified)
  treatment status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=1 durationMs=299671 providerRequests=15 toolSteps=13
             stopCause=wall-clock providerStop=aborted
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r008-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r008-treatment-338af700=destroyed (verified)
  delta     0.000  (both conditions graded)
pair 20261105T124949Z-cfc819ba-r009 (repetition 9)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=299618 providerRequests=30 toolSteps=29 redactions=1
             stopCause=wall-clock providerStop=aborted
             redactions=1 (session:ed0ee674.message.content[0].text)
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r009-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r009-baseline-338af700=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.800  checks=14/18 skillPaths=1 durationMs=81733 providerRequests=13 toolSteps=14
             stopCause=completed providerStop=STOP
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r009-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r009-treatment-338af700=destroyed (verified)
  delta     +0.600  (both conditions graded)
pair 20261105T124949Z-cfc819ba-r010 (repetition 10)
  baseline  status=task-limit             gradeable=true  score=0.200  checks=2/18 skillPaths=0 durationMs=300370 providerRequests=8 toolSteps=7
             stopCause=wall-clock providerStop=aborted
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r010-baseline-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r010-baseline-338af700=destroyed (verified)
  treatment status=completed              gradeable=true  score=0.900  checks=16/18 skillPaths=1 durationMs=43103 providerRequests=7 toolSteps=9
             stopCause=completed providerStop=STOP
             image=sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
             cleanup=guest:eval-guest-20261105t124949zcfc819ba-r010-treatment-338af700=destroyed (verified), network:eval-net-20261105t124949zcfc819ba-r010-treatment-338af700=destroyed (verified)
  delta     +0.700  (both conditions graded)
```

## Reproducibility

Recorded facts:

- Evaluator source revision: 79975e9fd5a92dc78e6c0964328627806dbc5caa (dirty working tree)
- Evaluator build: evals-src@bf86e72b0f5ee310
- Image digest(s): sha256:f43299f552a0345a2315c06ebd39a313abdf5ce64fc260e34d83ccd0b62684a0
- Skill snapshot tree sha256: 2315345cfe61ad6c62dcbbdab9d456cab8219e2ff9c51e394751e26bfd801d65
- SKILL.md sha256: 90acb3006d4daf824db78e307281e54669d6b6b73ca12b0f078ad757ae32c36a
- Provider: google
- Model: gemini-3.8-flash
- Thinking level: low
- Limits: per arm: time=300s, output tokens=unlimited, tool steps=unlimited, provider requests=unlimited
- Repetitions: 10

A comparable new run:

```text
pnpm eval -- --case network-config-01 --skill <path_to_skill> --model gemini-3.8-flash --thinking low --repetitions 10
```

Answers are not expected to be identical between runs; a new run measures the same task again and is compared with this one, not matched to it.
