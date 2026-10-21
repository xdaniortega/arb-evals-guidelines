# EVALS.MD: network-config-01

Agent: Pi · google/fake-model-0  
Skill: arbitrum-docs  
Run: run-001 · Pairs r001, r002, r003 · Hash: abababababababababababababababababababababababababababababababab  

![AF-Evaluation: completed · 100%](https://img.shields.io/badge/AF--Evaluation-completed%20%C2%B7%20100%25-blue)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 20% | 100% | +80 percentage points |
| Cost: recorded tokens | 1,650 | 1,650 | 0 (0.0%) |
| Latency | 12,345 ms | 12,345 ms | 0 ms (0.0%) |

## Scenario: network-config-01

### Accuracy Outcome Checks

Each check covers both production and staging.

| Check | Without this skill | With this skill |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 10/10 |
| Public RPC and explorer endpoints | 0/10 | 10/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 10/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Outcome total** | **0/80** | **80/80** |

For further details or to check run reproducibility see: https://github.com/example/evals/tree/HEAD/eval-cases/network-config-01/runs/run-001
