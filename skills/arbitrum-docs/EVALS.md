# arbitrum-docs — evaluation results

![network-config-01 78/100](https://img.shields.io/badge/network--config--01-78%2F100-brightgreen)

One paired evaluation of this skill, run in isolated guests with live provider and MCP access. The baseline arm
received no evaluated skill and no skill-declared tools; the treatment arm received this
skill and its declared MCP server configuration. Both arms had the same generic MCP
client extension; baseline started without configured servers. Both arms ran from the same
image digest and were graded by the same deterministic validator against the same oracle.

## Result

| | Baseline | Treatment | Delta |
|---|---|---|---|
| Score | 0.111 (2/18 checks) | **0.778 (14/18 checks)** | **+0.667** |
| Outcome | `task-limit` | `completed` | — |
| Agent duration | 163.3s | 225.6s | +62.2s |
| Consumed tokens (including cache usage) | 947,529 | 1,521,555 | +574,026 |
| Provider requests | 51 | 29 | −22 |

`metadata.evals` for this skill is **`NOT PASS`**. The treatment arm completed and both
arms were graded, but the baseline arm exhausted its 8,000-token cumulative output budget
after 51 provider requests instead of finishing, and operational acceptance requires both
arms to finish cleanly. The label records that acceptance bar; it is not a statement that
the skill performed badly.

That baseline behaviour is itself the most useful observation here: without the skill the
agent issued 51 requests, never converged, and spent its output budget, while the treatment
arm reached a graded answer in 29 requests.

## Exact conditions

| Field | Value |
|---|---|
| Case | `network-config-01` (version 7) |
| Model | `gemini-3.8-flash` (provider `google`) |
| Thinking | `low` |
| Repetitions | 1 (one baseline/treatment pair) |
| Per-arm wall clock | 300,000 ms default (10-minute maximum available via explicit override; not used) |
| Output token budget | 8,000 per arm (cumulative) |
| Provider request budget | 200 per arm |
| Tool step budget | 120 per arm |
| Date (UTC) | 2026-09-09 |
| Run id | `20260909T163327Z-1e39a443` |
| Image digest | `sha256:a083398b890509c4f0d2084fb9a9dcfa6308e75b173a8bffea6a05e04b731405` |
| Source revision | `c1037a16f5a458f6b7815b2aa41e6bb187a3d450` (clean tree) |
| Evaluator build | `evals-src@3babd816315b0af6` |
| Evidence chain | VERIFIED (manifest `05398e8e617c`) |

The `metadata.evals` label lives in `SKILL.md`, which is part of the measured skill
snapshot, so recording a result necessarily changes the bytes measured by the run that
produced it. This file is excluded from the snapshot; `SKILL.md` is not. The label above
was therefore written after the recorded run and differs by that one field from the bytes
that run measured. This measured revision predates the review fixes in this tree and this
post-run metadata correction; it is not an exact measurement of the current inputs.

## Reproduce

```bash
pnpm eval -- --case network-config-01 \
  --skill skills/arbitrum-docs \
  --model gemini-3.8-flash \
  --thinking low \
  --repetitions 1
```

Inspect the recorded run instead of paying for a new one:

```bash
pnpm eval:report -- --receipt evals/cases/network-config-01/runs/20260909T163327Z-1e39a443/receipt.json --format json
```

## What this does and does not show

- **One pair demonstrates operation, not statistical effectiveness.** A single
  baseline/treatment pair cannot establish an effect size, a confidence interval, or
  reproducibility of the delta. Agent runs are stochastic; another run of the same
  configuration could produce a different score.
- The measurement covers **this skill together with its declared MCP tools**, not the
  skill text in isolation. The treatment arm's retrieval calls are part of what was
  measured.
- Token, request and duration differences are execution diagnostics for this single run.
- Scores are the validator's fraction of passed checks for this one case. They do not
  generalize to other Arbitrum tasks.
