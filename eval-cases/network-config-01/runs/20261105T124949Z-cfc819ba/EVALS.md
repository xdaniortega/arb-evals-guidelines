# arbitrum-docs — Evaluation cases

## Case index

Score in this index is the Treatment score.

| Eval case | LLM model | Task | Score |
|---|---|---|---:|
| [network-config-01](#network-config-01) | Google Gemini 3.8 Flash | Network configuration migration | 69% |

## network-config-01

### Task

Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.

### Results

Metrics are means across all ten pairs. Recorded tokens include cached input; latency measures time to completion or termination.

| Metric | LLM model | Baseline | Treatment | Change |
| --- | --- | ---: | ---: | ---: |
| Score | Google Gemini 3.8 Flash | 20% | 69% | +49% |
| Cost: recorded tokens | Google Gemini 3.8 Flash | 698,606 | 173,219 | −525,387 (−75.2%) |
| Latency | Google Gemini 3.8 Flash | 300,012 ms | 133,444 ms | −166,568 ms (−55.5%) |

### Outcome Checks

| Eval case | Check | LLM model | Baseline | Treatment |
| --- | --- | --- | ---: | ---: |
| `network-config-01` | Correct network identities | Google Gemini 3.8 Flash | 0/10 | 8/10 |
| `network-config-01` | Legacy RPC fallback configuration | Google Gemini 3.8 Flash | 0/10 | 8/10 |
| `network-config-01` | Public RPC and explorer endpoints | Google Gemini 3.8 Flash | 0/10 | 4/10 |
| `network-config-01` | Sequencer routing and submission policy | Google Gemini 3.8 Flash | 0/10 | 8/10 |
| `network-config-01` | WETH and USDC token identities | Google Gemini 3.8 Flash | 0/10 | 8/10 |
| `network-config-01` | Canonical bridge addresses | Google Gemini 3.8 Flash | 0/10 | 0/10 |
| `network-config-01` | Bridge onboarding configuration | Google Gemini 3.8 Flash | 0/10 | 6/10 |
| `network-config-01` | Withdrawal finality and force-inclusion settings | Google Gemini 3.8 Flash | 0/10 | 8/10 |
| `network-config-01` | **Outcome total** | Google Gemini 3.8 Flash | **0/80** | **50/80** |

## Full reports

| Eval case | Report |
|---|---|
| network-config-01 | [View full report](https://github.com/xdaniortega/evals-example/blob/HEAD/eval-cases/network-config-01/runs/20261105T124949Z-cfc819ba/EVALS-FULL-REPORT.md) |

<!-- EVALS-ENTRY case=network-config-01 run=20261105T124949Z-cfc819ba selection=mean pairs=20261105T124949Z-cfc819ba-r001,20261105T124949Z-cfc819ba-r002,20261105T124949Z-cfc819ba-r003,20261105T124949Z-cfc819ba-r004,20261105T124949Z-cfc819ba-r005,20261105T124949Z-cfc819ba-r006,20261105T124949Z-cfc819ba-r007,20261105T124949Z-cfc819ba-r008,20261105T124949Z-cfc819ba-r009,20261105T124949Z-cfc819ba-r010 treeSha256=0fd51ed151b308982b3dea28e77fdd3ffdff4c6266b82b3dd16a4026aa16d171 -->
