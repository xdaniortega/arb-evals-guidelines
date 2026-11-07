# arbitrum-docs — Evaluation cases

## Case index

Score in this index is the Treatment score.

| Eval case | LLM model | Task | Score |
|---|---|---|---:|
| [network-config-01](#network-config-01) | Google Gemini 3.8 Flash | Network configuration migration | 64% |

## network-config-01

### Task

Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.

### Results

Metrics are means across all ten pairs. Recorded tokens include cached input; latency measures time to completion or termination.

| Metric | LLM model | Baseline | Treatment | Change |
| --- | --- | ---: | ---: | ---: |
| Score | Google Gemini 3.8 Flash | 20% | 64% | +44% |
| Cost: recorded tokens | Google Gemini 3.8 Flash | 899,838 | 274,804 | −625,034 (−69.5%) |
| Latency | Google Gemini 3.8 Flash | 299,967 ms | 205,548 ms | −94,419 ms (−31.5%) |

### Outcome Checks

| Eval case | Check | LLM model | Baseline | Treatment |
| --- | --- | --- | ---: | ---: |
| `network-config-01` | Correct network identities | Google Gemini 3.8 Flash | 0/10 | 7/10 |
| `network-config-01` | Legacy RPC fallback configuration | Google Gemini 3.8 Flash | 0/10 | 7/10 |
| `network-config-01` | Public RPC and explorer endpoints | Google Gemini 3.8 Flash | 0/10 | 7/10 |
| `network-config-01` | Sequencer routing and submission policy | Google Gemini 3.8 Flash | 0/10 | 7/10 |
| `network-config-01` | WETH and USDC token identities | Google Gemini 3.8 Flash | 0/10 | 7/10 |
| `network-config-01` | Canonical bridge addresses | Google Gemini 3.8 Flash | 0/10 | 0/10 |
| `network-config-01` | Bridge onboarding configuration | Google Gemini 3.8 Flash | 0/10 | 2/10 |
| `network-config-01` | Withdrawal finality and force-inclusion settings | Google Gemini 3.8 Flash | 0/10 | 7/10 |
| `network-config-01` | **Outcome total** | Google Gemini 3.8 Flash | **0/80** | **44/80** |

## Full reports

| Eval case | Report |
|---|---|
| network-config-01 | [View full report](https://github.com/xdaniortega/evals-example/blob/HEAD/eval-cases/network-config-01/runs/20261106T144334Z-97b4ed31/EVALS-FULL-REPORT.md) |

<!-- EVALS-ENTRY case=network-config-01 run=20261106T144334Z-97b4ed31 selection=mean pairs=20261106T144334Z-97b4ed31-r001,20261106T144334Z-97b4ed31-r002,20261106T144334Z-97b4ed31-r003,20261106T144334Z-97b4ed31-r004,20261106T144334Z-97b4ed31-r005,20261106T144334Z-97b4ed31-r006,20261106T144334Z-97b4ed31-r007,20261106T144334Z-97b4ed31-r008,20261106T144334Z-97b4ed31-r009,20261106T144334Z-97b4ed31-r010 treeSha256=6cac43dfd4d7e29e4535ea0e7d9926f0f2c56c1fe5513a553df9b5c801d313af -->
