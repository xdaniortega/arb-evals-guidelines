<!-- AF-EVAL:BEGIN generated -->
# EVALS.MD: network configuration migration

Agent: Pi · google/gemini-3.8-flash  
Skill: arbitrum-network  
Run: 20260924T170734Z-b115674e · Pairs r001, r002, r003  
Status: Completed; graded

![AF-Evaluation: completed · 80%](https://img.shields.io/badge/AF--Evaluation-completed%20%C2%B7%2080%25-blue)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 48.3% | 80% | +31.7 percentage points |
| Cost: recorded tokens | 5,473,447 | 104,124 | −5,369,323 (−98.1%) |
| Latency | 3m11s | 33.9s | −2m37s (−82.2%) |

## Scenario: Migrate production and staging network configuration to Arbitrum

### Accuracy

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 28.3/80 — 35% | 66.7/80 — 83% |
| Constraints and preservation | 20/20 — 100% | 13.3/20 — 67% |
| **Accuracy total** | **48.3/100 — 48%** | **80/100 — 80%** |

### Outcome checks

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
| Time to completion or termination | 3m10.561s | 33.922s |
<!-- AF-EVAL:END generated -->
