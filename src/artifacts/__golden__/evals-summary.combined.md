> **Warning:** TEST-DOUBLE EVIDENCE — synthetic scores, not a measured result

# arbitrum-docs — Evaluation cases

## Case index

Score is the Treatment score; the change from Baseline is in parentheses.

| Eval case | LLM model | Task | Score |
| --- | --- | --- | ---: |
| [network-config-01](#network-config-01) | Google Gemini 3.8 Flash | Network-config-01 title | 100% (+80%) |
| [network-config-01](#network-config-01) | Google Gemini 4 Argon | Network-config-01 title | 20% (0%) |

## network-config-01

### Task

Prompt of network-config-01.

### Results

Each cell shows Baseline → Treatment and, below it, the change.

Metrics are from a single pair. Recorded tokens include cached input; latency measures time to completion or termination.

| Eval case | LLM model | Score<br>(baseline vs treatment) | Recorded tokens<br>(baseline vs treatment) | Latency<br>(baseline vs treatment) |
| --- | --- | ---: | ---: | ---: |
| `network-config-01` | Google Gemini 3.8 Flash | 20% → 100%<br>+80% | 1,000 → 400<br>−600 (−60.0%) | 10,000 ms → 4,000 ms<br>−6,000 ms (−60.0%) |
| `network-config-01` | Google Gemini 4 Argon | 20% → 20%<br>0% | 1,000 → 400<br>−600 (−60.0%) | 10,000 ms → 4,000 ms<br>−6,000 ms (−60.0%) |

### Outcome Checks · network-config-01

Each cell shows Baseline → Treatment points; a single value means both arms scored the same.

| Check | Google Gemini 3.8 Flash | Google Gemini 4 Argon |
| --- | ---: | ---: |
| Correct network identities | 0/10 → 10/10 | 0/10 |
| Legacy RPC fallback configuration | 0/10 → 10/10 | 0/10 |
| Public RPC and explorer endpoints | 0/10 → 10/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 → 10/10 | 0/10 |
| WETH and USDC token identities | 0/10 → 10/10 | 0/10 |
| Canonical bridge addresses | 0/10 → 10/10 | 0/10 |
| Bridge onboarding configuration | 0/10 → 10/10 | 0/10 |
| Withdrawal finality and force-inclusion settings | 0/10 → 10/10 | 0/10 |
| **Outcome total** | **0/80 → 80/80** | **0/80** |

## Full reports

| Eval case | LLM model | Report |
| --- | --- | --- |
| network-config-01 | Google Gemini 3.8 Flash | [View full report](https://github.com/example/evals/blob/HEAD/eval-cases/network-config-01/runs/run-001/EVALS-FULL-REPORT.md) |
| network-config-01 | Google Gemini 4 Argon | [View full report](https://github.com/example/evals/blob/HEAD/eval-cases/network-config-01/runs/run-002/EVALS-FULL-REPORT.md) |

<!-- EVALS-ENTRY case=network-config-01 run=run-001 selection=single pairs=run-001-r001 treeSha256=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd -->
<!-- EVALS-ENTRY case=network-config-01 run=run-002 selection=single pairs=run-002-r001 treeSha256=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd -->
