<!-- AF-EVAL:BEGIN generated -->
# EVALS.MD: network configuration migration

Agent: Pi · google/gemini-3.8-flash  
Skill: arbitrum-docs  
Run: 20260924T151721Z-bfb34c20 · Pairs r001, r002, r003  
Status: Without this skill: task limit reached in 2 of 3 pairs, completed in 1, graded · With this skill: completed, graded

![AF-Evaluation: completed · 80%](https://img.shields.io/badge/AF--Evaluation-completed%20%C2%B7%2080%25-blue)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 40% | 80% | +40 percentage points |
| Cost: recorded tokens | 3,152,292 | 2,136,778 | −1,015,514 (−32.2%) |
| Latency | 4m58s | 3m55s | −1m03s (−21.1%) |

## Scenario: Migrate production and staging network configuration to Arbitrum

### Accuracy

| Check | Without this skill | With this skill |
|---|---:|---:|
| Outcome correctness and completeness | 20/80 — 25% | 60/80 — 75% |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **40/100 — 40%** | **80/100 — 80%** |

### Outcome checks

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
| Time to completion or termination | 4m58.395s | 3m55.438s |
<!-- AF-EVAL:END generated -->

The current case asks an agent to migrate a small application's production and staging
configuration from Ethereum to **Arbitrum One and Arbitrum Sepolia**. It measures whether
supplying this skill **and its declared documentation MCP setup** improves the resulting
configuration for a fixed model and thinking level.
