# arbitrum-docs — Evaluation cases

## Case index

Score is the Treatment score; the change from Baseline is in parentheses.

| Eval case | LLM model | Task | Score |
| --- | --- | --- | ---: |
| [network-config-01](#network-config-01) | Google Gemini 4 Argon | Network configuration migration | 90% (+19%) |

## network-config-01

### Task

Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.

### Results

Each cell shows Baseline → Treatment and, below it, the change.

Metrics are means across all ten pairs. Recorded tokens include cached input; latency measures time to completion or termination.

| Eval case | LLM model | Score<br>(baseline vs treatment) | Recorded tokens<br>(baseline vs treatment) | Latency<br>(baseline vs treatment) |
| --- | --- | ---: | ---: | ---: |
| `network-config-01` | Google Gemini 4 Argon | 71% → 90%<br>+19% | 335,566 → 52,307<br>−283,259 (−84.4%) | 340,495 ms → 128,457 ms<br>−212,038 ms (−62.3%) |

### Outcome Checks · network-config-01

Each cell shows Baseline → Treatment points; a single value means both arms scored the same.

| Check | Google Gemini 4 Argon |
| --- | ---: |
| Correct network identities | 10/10 |
| Legacy RPC fallback configuration | 10/10 |
| Public RPC and explorer endpoints | 8/10 → 10/10 |
| Sequencer routing and submission policy | 3/10 → 10/10 |
| WETH and USDC token identities | 10/10 |
| Canonical bridge addresses | 0/10 → 2/10 |
| Bridge onboarding configuration | 10/10 |
| Withdrawal finality and force-inclusion settings | 6/10 → 10/10 |
| **Outcome total** | **57/80 → 72/80** |

## Full reports

| Eval case | LLM model | Report |
| --- | --- | --- |
| network-config-01 | Google Gemini 4 Argon | [View full report](https://github.com/xdaniortega/arb-evals-guidelines/blob/HEAD/eval-cases/network-config-01/runs/20261117T102715Z-70287a51/EVALS-FULL-REPORT.md) |

<!-- EVALS-ENTRY case=network-config-01 run=20261117T102715Z-70287a51 selection=mean pairs=20261117T102715Z-70287a51-r001,20261117T102715Z-70287a51-r002,20261117T102715Z-70287a51-r003,20261117T102715Z-70287a51-r004,20261117T102715Z-70287a51-r005,20261117T102715Z-70287a51-r006,20261117T102715Z-70287a51-r007,20261117T102715Z-70287a51-r008,20261117T102715Z-70287a51-r009,20261117T102715Z-70287a51-r010 treeSha256=aad228edb48a265a5791ddbe47c2b574350e504db5dd17d944c442e08be19c21 -->
