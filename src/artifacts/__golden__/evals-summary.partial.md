> **Warning:** TEST-DOUBLE EVIDENCE — synthetic scores, not a measured result

# mcp-skill — Evaluation cases

## Case index

Score is the Treatment score; the change from Baseline is in parentheses.

| Eval case | LLM model | Task | Score |
| --- | --- | --- | ---: |
| [network-config-01](#network-config-01) | Google Fake Model 0 | Network configuration migration | 20% (0%) |

## network-config-01

### Task

Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.

### Results

Each cell shows Baseline → Treatment and, below it, the change.

Metrics are means across two of three pairs; pair r003 is excluded because its treatment arm was not graded. Recorded tokens include cached input; latency measures time to completion or termination.

| Eval case | LLM model | Score<br>(baseline vs treatment) | Recorded tokens<br>(baseline vs treatment) | Latency<br>(baseline vs treatment) |
| --- | --- | ---: | ---: | ---: |
| `network-config-01` | Google Fake Model 0 | 20% → 20%<br>0% | n/a → n/a<br>n/a | 0 ms → 0 ms<br>0 ms (n/a) |

### Outcome Checks · network-config-01

Each cell shows Baseline → Treatment points; a single value means both arms scored the same.

| Check | Google Fake Model 0 |
| --- | ---: |
| Correct network identities | 0/10 |
| Legacy RPC fallback configuration | 0/10 |
| Public RPC and explorer endpoints | 0/10 |
| Sequencer routing and submission policy | 0/10 |
| WETH and USDC token identities | 0/10 |
| Canonical bridge addresses | 0/10 |
| Bridge onboarding configuration | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 |
| **Outcome total** | **0/80** |

## Full reports

| Eval case | LLM model | Report |
| --- | --- | --- |
| network-config-01 | Google Fake Model 0 | [View full report](https://github.com/example/evals/blob/HEAD/eval-cases/network-config-01/runs/<run-id>/EVALS-FULL-REPORT.md) |

<!-- EVALS-ENTRY case=network-config-01 run=<run-id> selection=mean pairs=<run-id>-r001,<run-id>-r002 treeSha256=<sha256> -->
