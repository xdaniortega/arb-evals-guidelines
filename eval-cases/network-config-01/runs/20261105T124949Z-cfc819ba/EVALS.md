# EVALS.MD: network configuration migration

Agent: Pi · google/gemini-3.8-flash  
Skill: arbitrum-docs  
Run: 20261105T124949Z-cfc819ba · Pairs r001, r002, r003, r004, r005, r006, r007, r008, r009, r010 · Hash: 0fd51ed151b308982b3dea28e77fdd3ffdff4c6266b82b3dd16a4026aa16d171  

![AF-Evaluation: mixed · 69%](https://img.shields.io/badge/AF--Evaluation-mixed%20%C2%B7%2069%25-yellow)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 20% | 69% | +49 percentage points |
| Cost: recorded tokens | 698,606 | 173,219 | −525,387 (−75.2%) |
| Latency | 300,012 ms | 133,444 ms | −166,568 ms (−55.5%) |

## Scenario: Migrate production and staging network configuration to Arbitrum

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

For further details or to check run reproducibility see: https://github.com/xdaniortega/evals-example/blob/HEAD/eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/EVALS-FULL-REPORT.md
