# arbitrum-docs — Evaluation cases

## Case index

Score in this index is the Treatment score.

| Eval case | LLM model | Task | Score |
|---|---|---|---:|
| [network-config-01](#network-config-01) | Google Gemini 3.8 Flash | Network configuration migration | 70% |

## network-config-01

### Task

Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.

### Results

Metrics are from a single pair. Recorded tokens include cached input; latency measures time to completion or termination.

| Metric | LLM model | Baseline | Treatment | Change |
| --- | --- | ---: | ---: | ---: |
| Score | Google Gemini 3.8 Flash | 20% | 70% | +50% |
| Cost: recorded tokens | Google Gemini 3.8 Flash | 281,790 | 340,794 | +59,004 (+20.9%) |
| Latency | Google Gemini 3.8 Flash | 300,386 ms | 224,860 ms | −75,526 ms (−25.1%) |

### Outcome Checks

| Eval case | Check | LLM model | Baseline | Treatment |
| --- | --- | --- | ---: | ---: |
| `network-config-01` | Correct network identities | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | Legacy RPC fallback configuration | Google Gemini 3.8 Flash | 0/10 | 0/10 |
| `network-config-01` | Public RPC and explorer endpoints | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | Sequencer routing and submission policy | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | WETH and USDC token identities | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | Canonical bridge addresses | Google Gemini 3.8 Flash | 0/10 | 0/10 |
| `network-config-01` | Bridge onboarding configuration | Google Gemini 3.8 Flash | 0/10 | 0/10 |
| `network-config-01` | Withdrawal finality and force-inclusion settings | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | **Outcome total** | Google Gemini 3.8 Flash | **0/80** | **50/80** |

## Full reports

| Eval case | Report |
|---|---|
| network-config-01 | [View full report](https://github.com/xdaniortega/evals-example/blob/HEAD/eval-cases/network-config-01/runs/20261105T165811Z-2934dba4/EVALS-FULL-REPORT.md) |

<!-- EVALS-ENTRY case=network-config-01 run=20261105T165811Z-2934dba4 selection=single pairs=20261105T165811Z-2934dba4-r001 treeSha256=05b666900e8e926e6b6ef6240d7740990350cba43fc500c8a3bf76bcd8ed091a -->
