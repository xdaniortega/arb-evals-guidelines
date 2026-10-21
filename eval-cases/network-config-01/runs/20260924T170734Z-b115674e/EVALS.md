# EVALS.MD: network configuration migration

Agent: Pi · google/gemini-3.8-flash  
Skill: arbitrum-network  
Run: 20260924T170734Z-b115674e · Pairs r001, r002, r003 · Hash: 6897ffb3af741c6e4bba6f9ad6c7f18ea0cdddebfb4b616cc87dd3fbbea7eef5  

![AF-Evaluation: completed · 80%](https://img.shields.io/badge/AF--Evaluation-completed%20%C2%B7%2080%25-blue)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 48.3% | 80% | +31.7 percentage points |
| Cost: recorded tokens | 5,473,447 | 104,124 | −5,369,323 (−98.1%) |
| Latency | 190,561 ms | 33,922 ms | −156,639 ms (−82.2%) |

## Scenario: Migrate production and staging network configuration to Arbitrum

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

For further details or to check run reproducibility see: https://github.com/xdaniortega/evals-example/blob/HEAD/eval-cases/network-config-01/runs/20260924T170734Z-b115674e/EVALS-FULL-REPORT.md
