# network-config-01: Network Configuration Migration

| | |
|---|---|
| Case ID | `network-config-01` |
| Case version | `10` |
| Scoring standard | Rubric v0.2 (`rubric.json`) |
| Skill folder | `arbitrum-docs` (this case has also been published against `arbitrum-network`) |

## 1. Why this case exists

It measures whether a skill, and the documentation MCP server that the skill declares, helps an agent migrate an application's network configuration correctly. Both arms use the same model and thinking level. The baseline has no skill. The treatment has a frozen copy of the skill. The score difference is the observed effect of the skill on this one task. It is not a general quality rating of the skill.

## 2. The task

The agent receives this prompt, verbatim from `case.json`:

> Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.

- **Allowed tools:** `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- **Output:** the edited `config.json` in the workspace (`outputPath`).
- **Starting files:** `fixture/config.json`, a treasury console configuration. Under `networkConfig.environments.production` and `.staging` it holds `chain`, `rpcPolicy`, `contracts`, `tokens`, `assetOnboarding` and `finalityPolicy`, all pointing at Ethereum Mainnet and Ethereum Sepolia. Outside `networkConfig` it holds unrelated settings (`application`, `wallet`, `retry`).

## 3. Provenance

The reference answers in `oracle.json` come from these sources. The oracle stays hidden from the agent.

| Source | Fields | Checked on |
|---|---|---|
| [Arbitrum chain info](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info): Arbitrum One and Arbitrum Sepolia chain, RPC, sequencer behavior, finality parameters, WETH and bridge configuration | `chainIdentity`, `rpcPolicy`, `legacyNetworkFallback`, `sequencerPolicy`, `finalityPolicy`, `wrappedNativeTokens`, `bridgeOnboarding` | 2026-08-31 |
| [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses): Arbitrum One and Arbitrum Sepolia | `nativeUsdcTokens` | 2026-08-04 |
| [USDC on Arbitrum One](https://docs.arbitrum.io/arbitrum-bridge/usdc-arbitrum-one): USDC vs USDC.e table | `bridgedUsdcEToken` | 2026-08-04 |

## 4. Checks and weights

Accuracy = **Outcome correctness and completeness** (80 points, 16 checks: 8 topics &times; 2 environments, 5 points each) + **Constraints and preservation** (20 points: `json-shape` and `preservation`, 10 points each). The full table follows in [Rubric Checks](#rubric-checks-18-checks).

## 5. Unhappy paths

- The two `legacy-fallback` checks: the starting config points at retired Goerli endpoints (invalid input). The agent must remove them rather than migrate them.
- Staging `USDC.e` must stay `null`. A nonexistent token must not be invented. It is scored inside `staging-token-identity`.

## 6. Accepted variants

These differences are harmless and still pass:

- Bridge contract addresses at any of the accepted alias paths, as long as every populated alias agrees with the oracle (see [Alias-Tolerant Bridge Addresses](#alias-tolerant-bridge-addresses-vs-strict-json-shape)).
- Trailing slashes on URLs.
- Address letter case (EIP-55 checksums are accepted, not required).
- `preferredRoute` spelled `"canonicalBridge"` or `"canonical-bridge"`.
- `deprecatedGoerliFallbackUrl` set to `null` or removed.
- Key order and whitespace.

These must stay exact: chain ids and names, token addresses, the accepted sequencer method set, the finality numbers, and the canonical key names under `assetOnboarding.canonicalBridge.contracts` (needed for `json-shape`).

## 7. Preservation

Everything outside the mutable paths must keep its fixture value: `application.*`, `wallet.*`, `retry.*`, `networkConfig.defaultEnvironment` and `environments.*.contracts.multicall3`. The mutable paths are listed under [Scope of Preservation Checks](#scope-of-preservation-checks). The `preservation` and `json-shape` checks enforce this.

## 8. Score endpoints

See [Expected Scoring Endpoints](#expected-scoring-endpoints): correct answer 100/100 (PASS), unchanged fixture 20/100, malformed or missing `config.json` 0/100.

## 9. How to run it

From the repository root, with the submodule initialised and credentials in `.env`:

```bash
pnpm test:eval-cases   # validator tests
pnpm eval:validate -- --case network-config-01 --skill arbitrum-skill-evals/skills/arbitrum-docs
pnpm eval:doctor -- --model gemini-3.8-flash --thinking low
pnpm eval -- --case network-config-01 \
  --skill arbitrum-skill-evals/skills/arbitrum-docs \
  --model gemini-3.8-flash --limit wallClockMs=300000
```

Swap the `--skill` path to `arbitrum-skill-evals/skills/arbitrum-network` to evaluate the other skill. The root README explains inspecting and publishing a run.

## 10. Results

- Published reports sit next to each skill in arbitrum-skill-evals: `skills/arbitrum-docs/EVALS.md` and `skills/arbitrum-network/EVALS.md` (<ARBITRUM_SKILL_EVALS_URL>).
- Sealed evidence kept in this folder:
  - `runs/20260924T151721Z-bfb34c20`: `arbitrum-docs`, 3 pairs.
  - `runs/20260924T170734Z-b115674e`: `arbitrum-network`, 3 pairs.
- Verify a run with `pnpm eval:report -- --receipt eval-cases/arbitrum-docs/network-config-01/runs/<run-id>/receipt.json`.

Both runs were recorded before the repository layout changed, so their frozen skill path reads `skills/<name>`. Republish them with `--repo-root arbitrum-skill-evals`. Never edit files under `runs/`: that breaks verification.

## 11. Maintenance

- Bump `version` in `case.json` on any change to the prompt, fixture, oracle, validator or rubric, and re-verify the sources in the provenance table.
- Editing this README does not change the frozen inputs, so it does not need a version bump.
- Keep the check ids and weights here in step with `rubric.json` and `validator.ts`.

## 12. Limitations

- One task, so the result says nothing about the skill on other tasks.
- Single-pair and few-pair records do not establish a statistical result. The model's answers vary between attempts.
- Only the captured `config.json` is graded. The case does not assess permission boundaries, runtime access controls or external security guarantees.
- Results compare a skill against no skill for one model. Compare skills only within the same case and model.
- Latency is the agent's wall-clock time on the task, not the speed of the skill's API or transactions.

## Rubric Checks (18 Checks)

Every check is evaluated by `validator.ts` as a **binary** predicate (`passed: true` or `passed: false`). Partial credit within a single check is never awarded. When a check bundles multiple assertions (grouped predicates), **all assertions must pass** for the check to pass; any single discrepancy fails the entire check.

The 16 outcome checks are grouped into 8 display topics (10 points per topic, combining Production and Staging).

| Check ID | Display Topic | Group | Points | Tested Fields (JSON Keys) | Evidence Inspected | Passing Condition & Variants |
|---|---|---|---:|---|---|---|
| `json-shape` | Constraints and preservation | `constraints` | 10 | Complete JSON key topology across `config.json` | Candidate output JSON parsed against fixture JSON | The key hierarchy must match the fixture topology exactly, with only two permitted differences: (1) an added `assetOnboarding.canonicalBridge.contracts` subtree is allowed *only if* every key inside it is one of the four canonical bridge contract keys (`l1GatewayRouter`, `l2GatewayRouter`, `l1Erc20Gateway`, `l1Outbox`); and (2) `deprecatedGoerliFallbackUrl` may be cleared or removed. Array contents and scalar values are invisible to shape (`jsonKeyShape` collapses arrays to `{type: "array"}` and scalars to `"value"`); content changes fail `preservation`, not `json-shape`. Any missing container key, extra key, or alias-spelled key outside canonical names fails shape. |
| `preservation` | Constraints and preservation | `constraints` | 10 | Unrelated application settings, `wallet`, `retry`, `contracts.multicall3`, `defaultEnvironment` | Values across all non-mutable paths compared between candidate and fixture | Exact value preservation (`isDeepStrictEqual`) on all non-mutable paths. Mutable paths allowed to change are: `chain.*`, `rpcPolicy.*`, `tokens.*`, `finalityPolicy.*`, `assetOnboarding.enabled`, `assetOnboarding.preferredRoute`, `assetOnboarding.canonicalBridge.enabled`, and `assetOnboarding.canonicalBridge.contracts`. All other keys (e.g. `application.*`, `wallet.*`, `retry.*`, `networkConfig.defaultEnvironment`, `environments.*.contracts.multicall3`) must remain unchanged. |
| `production-chain-identity` | Correct network identities | `outcome` | 5 | `networkConfig.environments.production.chain` (`name`, `chainId`, `rpcUrl`, `explorerUrl`) | `chain` object in production | `name === "Arbitrum One"`, `chainId === 42161`, `rpcUrl === "https://arb1.arbitrum.io/rpc"`, and `explorerUrl === "https://arbiscan.io"`. URLs are compared canonically (trailing slashes tolerated). |
| `staging-chain-identity` | Correct network identities | `outcome` | 5 | `networkConfig.environments.staging.chain` (`name`, `chainId`, `rpcUrl`, `explorerUrl`) | `chain` object in staging | `name === "Arbitrum Sepolia"`, `chainId === 421614`, `rpcUrl === "https://sepolia-rollup.arbitrum.io/rpc"`, and `explorerUrl === "https://sepolia.arbiscan.io"`. URLs are compared canonically (trailing slashes tolerated). |
| `production-legacy-fallback` | Legacy RPC fallback configuration | `outcome` | 5 | `networkConfig.environments.production.chain.deprecatedGoerliFallbackUrl` | `chain` object in production | Must be set to `null` or the key must be omitted/deleted. Furthermore, no string value in the `chain` object may contain `"goerli"` (case-insensitive); relocating the retired Goerli fallback to another key fails. |
| `staging-legacy-fallback` | Legacy RPC fallback configuration | `outcome` | 5 | `networkConfig.environments.staging.chain.deprecatedGoerliFallbackUrl` | `chain` object in staging | Must be set to `null` or the key must be omitted/deleted. No string value in the `chain` object may contain `"goerli"` (case-insensitive); relocating the retired Goerli fallback to another key fails. |
| `production-rpc-endpoints` | Public RPC and explorer endpoints | `outcome` | 5 | `networkConfig.environments.production.rpcPolicy` (`readRpcUrl`, `writeRpcUrl`, `sequencerSubmissionUrl`) | `rpcPolicy` endpoint keys in production | `readRpcUrl === "https://arb1.arbitrum.io/rpc"`, `writeRpcUrl === "https://arb1.arbitrum.io/rpc"`, and `sequencerSubmissionUrl === "https://arb1-sequencer.arbitrum.io/rpc"`. URLs compared canonically (trailing slashes tolerated). Note: Public RPC and explorer endpoints are split across `chain` and `rpcPolicy` (see Endpoint Locations below). |
| `staging-rpc-endpoints` | Public RPC and explorer endpoints | `outcome` | 5 | `networkConfig.environments.staging.rpcPolicy` (`readRpcUrl`, `writeRpcUrl`, `sequencerSubmissionUrl`) | `rpcPolicy` endpoint keys in staging | `readRpcUrl === "https://sepolia-rollup.arbitrum.io/rpc"`, `writeRpcUrl === "https://sepolia-rollup.arbitrum.io/rpc"`, and `sequencerSubmissionUrl === "https://sepolia-rollup-sequencer.arbitrum.io/rpc"`. URLs compared canonically (trailing slashes tolerated). |
| `production-sequencer-policy` | Sequencer routing and submission policy | `outcome` | 5 | `networkConfig.environments.production.rpcPolicy` (`sequencerSubmissionOnly`, `sequencerAcceptedMethods`, `retryableSubmissionErrors`, `terminalSubmissionErrors`) | `rpcPolicy` policy keys in production | Grouped binary check: (1) `sequencerSubmissionOnly === true`; (2) `sequencerAcceptedMethods` contains exactly `["eth_sendRawTransaction", "eth_sendRawTransactionConditional"]` (order-independent, no duplicates); (3) `retryableSubmissionErrors` includes `"context deadline exceeded"`; (4) `terminalSubmissionErrors` includes `"execution reverted"` and `"nonce too low"`; (5) `retryableSubmissionErrors` and `terminalSubmissionErrors` sets are strictly disjoint (no error may appear in both). |
| `staging-sequencer-policy` | Sequencer routing and submission policy | `outcome` | 5 | `networkConfig.environments.staging.rpcPolicy` (`sequencerSubmissionOnly`, `sequencerAcceptedMethods`, `retryableSubmissionErrors`, `terminalSubmissionErrors`) | `rpcPolicy` policy keys in staging | Grouped binary check: same criteria as production: `sequencerSubmissionOnly === true`, exact accepted methods set, retryable includes `"context deadline exceeded"`, terminal includes `"execution reverted"` and `"nonce too low"`, and sets are strictly disjoint. |
| `production-token-identity` | WETH and USDC token identities | `outcome` | 5 | `networkConfig.environments.production.tokens` (`WETH`, `USDC`, `USDC.e`) | `tokens` object in production | Grouped binary check: (1) `WETH` matches `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` (case-insensitive 20-byte address); (2) `USDC` (native USDC) matches `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`; (3) `USDC.e` (bridged USDC) matches `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8`. (See Token Identity and USDC.e Handling below). |
| `staging-token-identity` | WETH and USDC token identities | `outcome` | 5 | `networkConfig.environments.staging.tokens` (`WETH`, `USDC`, `USDC.e`) | `tokens` object in staging | Grouped binary check: (1) `WETH` matches `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73`; (2) `USDC` matches `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`; (3) `USDC.e` must be `null` (nullable token handling). |
| `production-bridge-addresses` | Canonical bridge addresses | `outcome` | 5 | Canonical bridge contract addresses under production environment | Resolved across accepted alias paths for each bridge contract | All 4 canonical bridge contracts must resolve to their correct Arbitrum One addresses (case-insensitive): `l1GatewayRouter`: `0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef`; `l2GatewayRouter`: `0x5288c571Fd7aD117beA99bF60FE0846C4E84F933`; `l1Erc20Gateway`: `0xa3A7B6F88361F48403514059F1F16C8E78d60EeC`; `l1Outbox`: `0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840`. For each key, at least one alias path must be present, all populated alias paths must agree with the oracle address, and conflicting aliases fail. |
| `staging-bridge-addresses` | Canonical bridge addresses | `outcome` | 5 | Canonical bridge contract addresses under staging environment | Resolved across accepted alias paths for each bridge contract | All 4 canonical bridge contracts must resolve to their correct Arbitrum Sepolia addresses (case-insensitive): `l1GatewayRouter`: `0xcE18836b233C83325Cc8848CA4487e94C6288264`; `l2GatewayRouter`: `0x9fDD1C4E4AA24EEc1d913FABea925594a20d43C7`; `l1Erc20Gateway`: `0x902b3E5f8F19571859F4AB1003B960a5dF693aFF`; `l1Outbox`: `0x65f07C7D521164a4d5DaC6eB8Fac8DA067A3B78F`. Evaluated with same alias-tolerant rules. |
| `production-bridge-onboarding` | Bridge onboarding configuration | `outcome` | 5 | `networkConfig.environments.production.assetOnboarding` (`enabled`, `preferredRoute`, `canonicalBridge.enabled`) | `assetOnboarding` object in production | Grouped binary check: (1) `enabled === true`; (2) `preferredRoute` must be `"canonicalBridge"` or `"canonical-bridge"`; (3) `canonicalBridge.enabled === true`. |
| `staging-bridge-onboarding` | Bridge onboarding configuration | `outcome` | 5 | `networkConfig.environments.staging.assetOnboarding` (`enabled`, `preferredRoute`, `canonicalBridge.enabled`) | `assetOnboarding` object in staging | Grouped binary check: same criteria as production: `enabled === true`, `preferredRoute` is canonical bridge, and `canonicalBridge.enabled === true`. |
| `production-finality-policy` | Withdrawal finality and force-inclusion settings | `outcome` | 5 | `networkConfig.environments.production.finalityPolicy` (`withdrawalsToEthereumAreInstant`, `challengeWindowBlocks`, `forceIncludePeriodBlocks`) | `finalityPolicy` object in production | Grouped binary check: (1) `withdrawalsToEthereumAreInstant === false`; (2) `challengeWindowBlocks === 45818` (~7-day dispute period for Arbitrum One); (3) `forceIncludePeriodBlocks === 5760` (~24 hours). |
| `staging-finality-policy` | Withdrawal finality and force-inclusion settings | `outcome` | 5 | `networkConfig.environments.staging.finalityPolicy` (`withdrawalsToEthereumAreInstant`, `challengeWindowBlocks`, `forceIncludePeriodBlocks`) | `finalityPolicy` object in staging | Grouped binary check: (1) `withdrawalsToEthereumAreInstant === false`; (2) `challengeWindowBlocks === 20` (short testnet challenge window for Arbitrum Sepolia); (3) `forceIncludePeriodBlocks === 5760` (~24 hours). |

## Detailed Grading Mechanics

### Binary Scoring of Grouped Predicates

Every check in the validator is **binary**:
- A check scores either its full declared points (5 or 10) or 0.
- When a check encompasses multiple fields (such as `token-identity` testing WETH, USDC, and USDC.e, or `sequencer-policy` testing flags, methods, retryable errors, and terminal errors), **all sub-predicates must satisfy the passing condition**. If even one field is incorrect, missing, or contradictory, the check evaluates to `passed: false` and contributes 0 points.
- Failed checks retain their weight in the accuracy denominator. Missing evidence does not trigger reweighting.

### Token Identity and USDC.e Handling

The `tokens` object includes three keys: `WETH`, `USDC`, and `USDC.e`.

1. **Production (Arbitrum One)**:
   - `WETH`: `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`
   - `USDC` (native USDC issued by Circle): `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
   - `USDC.e` (bridged USDC from Ethereum via canonical bridge): `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8`
   - On Arbitrum One, both native USDC and bridged USDC.e coexist as distinct tokens. Both addresses must be present and exact.

2. **Staging (Arbitrum Sepolia)**:
   - `WETH`: `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73`
   - `USDC` (native / testnet USDC): `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`
   - `USDC.e`: must be `null` (nullable token handling).
   - On Arbitrum Sepolia, there is no canonical bridged USDC.e token. The `USDC.e` key is strictly expected to be `null`. Setting a non-null string address or omitting/inventing a value fails `staging-token-identity`.

3. **Address comparison**:
   - Address comparisons are case-insensitive hex comparisons (`/^0x[0-9a-fA-F]{40}$/`). EIP-55 checksumming is accepted but not required.

### Endpoint Locations

Endpoint checks inspect URLs across two distinct configuration blocks within each environment:

1. **`networkConfig.environments.<env>.chain`**:
   - `rpcUrl`: Evaluated by `chain-identity` (e.g. `https://arb1.arbitrum.io/rpc` or `https://sepolia-rollup.arbitrum.io/rpc`).
   - `explorerUrl`: Evaluated by `chain-identity` (e.g. `https://arbiscan.io` or `https://sepolia.arbiscan.io`).
   - `deprecatedGoerliFallbackUrl`: Evaluated by `legacy-fallback` (must be `null` or deleted; no Goerli references allowed anywhere in `chain`).

2. **`networkConfig.environments.<env>.rpcPolicy`**:
   - `readRpcUrl`: Evaluated by `rpc-endpoints` (public read RPC).
   - `writeRpcUrl`: Evaluated by `rpc-endpoints` (public write RPC).
   - `sequencerSubmissionUrl`: Evaluated by `rpc-endpoints` (dedicated sequencer submission endpoint, e.g. `https://arb1-sequencer.arbitrum.io/rpc` or `https://sepolia-rollup-sequencer.arbitrum.io/rpc`).

All URL comparisons use canonical normalization (protocol validation, removing trailing slashes).

### Alias-Tolerant Bridge Addresses vs. Strict JSON Shape

The validator accepts several common structural aliases for canonical bridge contracts during fact grading (`bridge-addresses`), but strictly enforces topology during shape checking (`json-shape`):

- **Accepted alias paths for address grading (`BRIDGE_ADDRESS_ALIASES`)**:
  - `assetOnboarding.canonicalBridge.contracts.<key>` (canonical)
  - `assetOnboarding.canonicalBridge.<key>`
  - `contracts.<key>`
  - `bridgeContracts.<name>` accepting the four literal names: `parentL1GatewayRouter`, `childL2GatewayRouter`, `parentL1Erc20Gateway`, `parentOutbox` (note: `parentOutbox`, NOT `parentL1Outbox`).
  - Spellings `l1Erc20Gateway` and `l1ERC20Gateway`, as well as `l1Outbox` and `outbox`.
- **Address passing condition**: Every key must resolve to at least one known path, every populated path must match the oracle address, and conflicting aliases fail.
- **Topology requirement (`json-shape`)**: While the alias paths allow the address check to pass, `json-shape` *strictly requires* the canonical topology: contracts must reside in `assetOnboarding.canonicalBridge.contracts` with exact canonical key names (`l1GatewayRouter`, `l2GatewayRouter`, `l1Erc20Gateway`, `l1Outbox`). Using an alias path outside this allowed subtree fails `json-shape`.

### Scope of Preservation Checks

The `preservation` check verifies deep value equality on parsed JSON (`fixtureValuesPreserved` uses `isDeepStrictEqual`; formatting, whitespace, and key order are irrelevant) across non-mutable paths in `config.json` against the initial fixture. Specifically:
- It checks the **captured configuration structure and values** (e.g., `application.name`, `application.features`, `wallet`, `retry`, `contracts.multicall3`, `networkConfig.defaultEnvironment`).
- It **does NOT assess all possible permission boundaries, runtime access controls, or external system security guarantees**. It is scoped strictly to preventing regressions and unwanted mutations within the target workspace file.

## Expected Scoring Endpoints

Under Rubric v0.2, the scoring engine produces the following authoritative outcomes for representative execution states:

| Scenario | Check Results | Accuracy Score | Full Pass | Grading Status | Description |
|---|---|---:|:---:|:---:|---|
| **Correct output** | All 18 checks pass | **100%** (100/100) | `true` | `graded` | Complete and correct migration matching oracle facts, shape, and preservation rules. Outcome: 80/80, Constraints: 20/20. |
| **Unchanged fixture** | `json-shape` passes (10), `preservation` passes (10), all 16 outcome checks fail (0) | **20%** (20/100) | `false` | `graded` | The candidate made no modifications to `config.json`. Key topology and fixture values are preserved, but all Arbitrum migration facts fail. |
| **Missing or malformed output** | Output file missing or unparseable JSON; all 18 checks marked failed | **0%** (0/100) | `false` | `graded` | Candidate failed to produce a valid `config.json`. The validator emits zero scores across all checks. |
| **Invalid grading infrastructure** | Fixture missing, oracle corrupted, or internal harness error | **Ungraded** (`null`) | `null` | `infrastructure-failure` | Sentinel `validator-infrastructure` returned. No score is computed; treated as an infrastructure error rather than agent failure. |
