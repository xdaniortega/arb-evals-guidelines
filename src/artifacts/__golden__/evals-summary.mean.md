# arbitrum-docs — Evaluation cases

## Case index

Score in this index is the Treatment score.

| Eval case | LLM model | Task | Score |
|---|---|---|---:|
| [network-config-01](#network-config-01) | Google Gemini 3.8 Flash | Network-config-01 title | 100% |

## network-config-01

### Task

Prompt of network-config-01.

### Results

Metrics are means across all three pairs. Recorded tokens include cached input; latency measures time to completion or termination.

| Metric | LLM model | Baseline | Treatment | Change |
| --- | --- | ---: | ---: | ---: |
| Score | Google Gemini 3.8 Flash | 20% | 100% | +80% |
| Cost: recorded tokens | Google Gemini 3.8 Flash | 1,000 | 400 | −600 (−60.0%) |
| Latency | Google Gemini 3.8 Flash | 10,000 ms | 4,000 ms | −6,000 ms (−60.0%) |

### Outcome Checks

| Eval case | Check | LLM model | Baseline | Treatment |
| --- | --- | --- | ---: | ---: |
| `network-config-01` | Correct network identities | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | Legacy RPC fallback configuration | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | Public RPC and explorer endpoints | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | Sequencer routing and submission policy | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | WETH and USDC token identities | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | Canonical bridge addresses | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | Bridge onboarding configuration | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | Withdrawal finality and force-inclusion settings | Google Gemini 3.8 Flash | 0/10 | 10/10 |
| `network-config-01` | **Outcome total** | Google Gemini 3.8 Flash | **0/80** | **80/80** |

## Full reports

| Eval case | Report |
|---|---|
| network-config-01 | [View full report](https://github.com/example/evals/blob/HEAD/eval-cases/network-config-01/runs/run-001/EVALS-FULL-REPORT.md) |

<!-- EVALS-ENTRY case=network-config-01 run=run-001 selection=mean pairs=run-001-r001,run-001-r002,run-001-r003 treeSha256=cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd -->
