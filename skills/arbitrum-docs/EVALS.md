# arbitrum-docs — evaluation results

<!-- AF-EVAL:BEGIN generated -->
# EVALS.MD: network configuration migration

Agent: Pi · google/gemini-3.8-flash  
Skill: arbitrum-docs  
Run: 20260919T203602Z-28a00503 · Pair 20260919T203602Z-28a00503-r001  
Status: Baseline: task-limit / NOT PASS; Treatment: completed / NOT PASS

![AF-Evaluation Badge](https://img.shields.io/badge/AF--Evaluation-completed--70%25-blue)

| Pillar | Without this skill | With this skill | Change |
|---|---:|---:|---:|
| Accuracy | 20% | 70% | +50 percentage points |
| Cost: recorded tokens | 2,106,273 | 921,312 | -1,184,961 (-56.3%) |
| Latency | 300.2s | 90.0s | -210.2s (-70.0%) |

## Scenario: Migrate production and staging network configuration to Arbitrum

### Accuracy

| Check | Without this skill | With this skill |
|---|---:|---:|
| Normal execution: correct and complete migration | 0/80 — 0% | 50/80 — 63% |
| Unhappy-path handling | 0/0 — not defined | 0/0 — not defined |
| Constraints and preservation | 20/20 — 100% | 20/20 — 100% |
| **Accuracy total** | **20/100 — 20%** | **70/100 — 70%** |

### Normal execution checks

Each check covers both production and staging.

| Check | Without this skill | With this skill |
|---|---:|---:|
| Correct network identities | 0/10 | 10/10 |
| Legacy RPC fallback configuration | 0/10 | 0/10 |
| Public RPC and explorer endpoints | 0/10 | 0/10 |
| Sequencer routing and submission policy | 0/10 | 10/10 |
| WETH and USDC token identities | 0/10 | 10/10 |
| Canonical bridge addresses | 0/10 | 0/10 |
| Bridge onboarding configuration | 0/10 | 10/10 |
| Withdrawal finality and force-inclusion settings | 0/10 | 10/10 |
| **Normal execution total** | **0/80** | **50/80** |

### Cost and latency

| Metric | Without this skill | With this skill |
|---|---:|---:|
| Total recorded tokens, including cached input | 2,106,273 | 921,312 |
| Time to completion or termination | 300.155s | 89.975s |
<!-- AF-EVAL:END generated -->

The current case asks an agent to migrate a small application's production and staging
configuration from Ethereum to **Arbitrum One and Arbitrum Sepolia**. It measures whether
supplying this skill **and its declared documentation MCP setup** improves the resulting
configuration for a fixed model and thinking level.

## Current case assessment

The [case prompt](../../evals/cases/network-config-01/case.json) names the migration work:
network identities, public RPC and explorer endpoints, sequencer routing and submission
policy, withdrawal finality and force inclusion, canonical bridge onboarding, and token
identities. Both arms start from the same [Ethereum configuration](../../evals/cases/network-config-01/fixture/config.json)
with incomplete migration fields. Unrelated application, wallet, retry, and preserved
contract settings must stay intact. The prompt is intentionally guided; this is not a
test of discovering the migration requirements unaided.

Baseline receives no evaluated skill or seeded documentation servers. Treatment receives
one frozen copy of this skill and its declared documentation-server connection. Both
receive the same generic MCP client, ambient tools, public internet access, and frozen
task inputs. Baseline may connect to endpoints it discovers independently. This measures
the supplied bundle, without isolating written guidance from documentation access.

The [validator](../../evals/cases/network-config-01/validator.ts) defines 18 checks:

- Two global checks cover configuration structure and preservation of unrelated values (Constraints and preservation).
- Eight checks for each environment cover chain identity, Goerli removal, RPC endpoints,
  sequencer policy, token identities, bridge addresses, bridge onboarding, and
  finality/force-inclusion settings (Outcome correctness and completeness).

Under rubric v0.2, accuracy = Outcome correctness and completeness (80 points, 16 checks:
8 topics × 2 environments, 5 each) + Constraints and preservation (20 points: `json-shape`,
`preservation`, 10 each). Unhappy-path coverage sits inside Outcome: the two `legacy-fallback`
checks start from retired Goerli endpoints (invalid input) that the agent must remove rather
than migrate, and staging `USDC.e` must stay `null` rather than be invented (scored inside
`staging-token-identity`). Score endpoints: correct answer 100/100 (PASS); unchanged fixture
20/100; malformed or missing `config.json` 0/100. The [validator tests](../../evals/cases/network-config-01/validator.test.ts)
cover meaningful wrong answers, preservation, accepted variants, and invalid grading inputs.

These are grouped checks on one answer, not 18 independent experimental observations.
A paired repetition is the comparison unit. Time, tokens, tool actions, and provider
requests are diagnostics and do not add correctness points. A gradeable task-limit
answer keeps its ordinary score and can pass if every check passes; a limit alone does
not force failure. Invalid pairs do not contribute a delta or comparison average.

### Capability-to-case map

“Covered” refers only to the named assertions in this case, not mastery of the whole
capability. An uncovered capability has not been evaluated; it has not failed.

| Capability | Existing case | Assessment scope | Coverage |
| --- | --- | --- | --- |
| One/Sepolia configuration and token identities | `network-config-01` | Final chain, endpoint, WETH/USDC/USDC.e, and Goerli-removal values | Covered for the specified configuration |
| Sequencer routing and submission policy | `network-config-01` | Endpoint, submission-only setting, accepted methods, and retry/error classification | Covered as stored configuration; no live submission test |
| Canonical bridge onboarding | `network-config-01` | Required addresses, enabled state, and preferred route | Partly covered; no deposit/withdrawal execution |
| Withdrawal finality and force inclusion | `network-config-01` | Configured finality and force-inclusion values | Partly covered; no lifecycle execution |
| Safe application migration | `network-config-01` | Required JSON structure and unrelated-value preservation | Covered for the fixed fixture |
| Documentation grounding and fallback | `network-config-01` | Final-answer correctness with the declared documentation setup available | Partly covered; retrieval choices, citations, unavailable sources, and contradictory sources are not graded |
| System interfaces and precompiles | None | ArbSys, ArbGasInfo, NodeInterface, and related interface use | Not yet evaluated |
| SDK integration, deployment, and troubleshooting | None | Broader implementation and diagnostic workflows named by the skill | Not yet evaluated |

See the [operator guide](../../evals/README.md#3-how-scoring-works) for grading and evidence handling.
The [oracle](../../evals/cases/network-config-01/oracle.json) records expected values and
their source references; those expectations remain hidden from the model guests.
