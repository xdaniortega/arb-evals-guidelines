# EVALS.MD: network configuration migration

Agent: Pi · google/gemini-3.8-flash  
Skill: arbitrum-docs  
Run: 20260924T151721Z-bfb34c20 · Pairs r001, r002, r003 · Hash: 9f885c24411ba4ce72cac7190feeffef77b2fe58b4bdc0ddef74828afe9abaac  

![AF-Evaluation: completed · 80%](https://img.shields.io/badge/AF--Evaluation-completed%20%C2%B7%2080%25-blue)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 40% | 80% | +40 percentage points |
| Cost: recorded tokens | 3,152,292 | 2,136,778 | −1,015,514 (−32.2%) |
| Latency | 298,395 ms | 235,438 ms | −62,957 ms (−21.1%) |

## Scenario: Migrate production and staging network configuration to Arbitrum

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

For further details or to check run reproducibility see: https://github.com/xdaniortega/evals-example/blob/HEAD/eval-cases/network-config-01/runs/20260924T151721Z-bfb34c20/EVALS-FULL-REPORT.md
