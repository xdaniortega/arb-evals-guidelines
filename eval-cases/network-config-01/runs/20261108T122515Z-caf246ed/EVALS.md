# arbitrum-docs — Evaluation cases

## Case index

Score is the Treatment score; the change from Baseline is in parentheses.

| Eval case | LLM model | Task | Score |
| --- | --- | --- | ---: |
| [network-config-01](#network-config-01) | Google Gemini 3.8 Flash | Network configuration migration | 76% (+56%) |

## network-config-01

### Task

Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.

### Results

Each cell shows Baseline → Treatment and, below it, the change.

Metrics are means across all ten pairs. Recorded tokens include cached input; latency measures time to completion or termination.

| Eval case | LLM model | Score<br>(baseline vs treatment) | Recorded tokens<br>(baseline vs treatment) | Latency<br>(baseline vs treatment) |
| --- | --- | ---: | ---: | ---: |
| `network-config-01` | Google Gemini 3.8 Flash | 20% → 76%<br>+56% | 1,049,065 → 415,779<br>−633,286 (−60.4%) | 299,887 ms → 162,744 ms<br>−137,143 ms (−45.7%) |

### Outcome Checks · network-config-01

Each cell shows Baseline → Treatment points; a single value means both arms scored the same.

| Check | Google Gemini 3.8 Flash |
| --- | ---: |
| Correct network identities | 0/10 → 8/10 |
| Legacy RPC fallback configuration | 0/10 → 8/10 |
| Public RPC and explorer endpoints | 0/10 → 8/10 |
| Sequencer routing and submission policy | 0/10 → 8/10 |
| WETH and USDC token identities | 0/10 → 8/10 |
| Canonical bridge addresses | 0/10 |
| Bridge onboarding configuration | 0/10 → 8/10 |
| Withdrawal finality and force-inclusion settings | 0/10 → 8/10 |
| **Outcome total** | **0/80 → 56/80** |

## Full reports

| Eval case | LLM model | Report |
| --- | --- | --- |
| network-config-01 | Google Gemini 3.8 Flash | [View full report](https://github.com/xdaniortega/evals-example/blob/HEAD/eval-cases/network-config-01/runs/20261108T122515Z-caf246ed/EVALS-FULL-REPORT.md) |

<!-- EVALS-ENTRY case=network-config-01 run=20261108T122515Z-caf246ed selection=mean pairs=20261108T122515Z-caf246ed-r001,20261108T122515Z-caf246ed-r002,20261108T122515Z-caf246ed-r003,20261108T122515Z-caf246ed-r004,20261108T122515Z-caf246ed-r005,20261108T122515Z-caf246ed-r006,20261108T122515Z-caf246ed-r007,20261108T122515Z-caf246ed-r008,20261108T122515Z-caf246ed-r009,20261108T122515Z-caf246ed-r010 treeSha256=2a79367788819a66f6e3a4a21746e0c5af8e8b6f194dbc0289d46889cfd0977f -->
