# arbitrum-docs — Evaluation cases

## Case index

Score is the Treatment score; the change from Baseline is in parentheses.

| Eval case | LLM model | Task | Score |
| --- | --- | --- | ---: |
| [network-config-01](#network-config-01) | Google Gemini 3.8 Flash | Network configuration migration | 90% (+31.5%) |

## network-config-01

### Task

Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.

### Results

Each cell shows Baseline → Treatment and, below it, the change.

Metrics are means across all ten pairs. Recorded tokens include cached input; latency measures time to completion or termination.

| Eval case | LLM model | Score<br>(baseline vs treatment) | Recorded tokens<br>(baseline vs treatment) | Latency<br>(baseline vs treatment) |
| --- | --- | ---: | ---: | ---: |
| `network-config-01` | Google Gemini 3.8 Flash | 58.5% → 90%<br>+31.5% | 8,753,452 → 614,460<br>−8,138,992 (−93.0%) | 665,278 ms → 189,899 ms<br>−475,379 ms (−71.5%) |

### Outcome Checks · network-config-01

Each cell shows Baseline → Treatment points; a single value means both arms scored the same.

| Check | Google Gemini 3.8 Flash |
| --- | ---: |
| Correct network identities | 10/10 |
| Legacy RPC fallback configuration | 0/10 → 10/10 |
| Public RPC and explorer endpoints | 7.5/10 → 10/10 |
| Sequencer routing and submission policy | 1/10 → 10/10 |
| WETH and USDC token identities | 10/10 |
| Canonical bridge addresses | 0/10 |
| Bridge onboarding configuration | 9/10 → 10/10 |
| Withdrawal finality and force-inclusion settings | 1/10 → 10/10 |
| **Outcome total** | **38.5/80 → 70/80** |

## Full reports

| Eval case | LLM model | Report |
| --- | --- | --- |
| network-config-01 | Google Gemini 3.8 Flash | [View full report](https://github.com/xdaniortega/arb-evals-guidelines/blob/HEAD/eval-cases/network-config-01/runs/20261117T112937Z-ffe833a4/EVALS-FULL-REPORT.md) |

<!-- EVALS-ENTRY case=network-config-01 run=20261117T112937Z-ffe833a4 selection=mean pairs=20261117T112937Z-ffe833a4-r001,20261117T112937Z-ffe833a4-r002,20261117T112937Z-ffe833a4-r003,20261117T112937Z-ffe833a4-r004,20261117T112937Z-ffe833a4-r005,20261117T112937Z-ffe833a4-r006,20261117T112937Z-ffe833a4-r007,20261117T112937Z-ffe833a4-r008,20261117T112937Z-ffe833a4-r009,20261117T112937Z-ffe833a4-r010 treeSha256=4489d036b9da449ab677ac403029d040d57b066831cb4c0c2796fcf85be0fa6c -->
