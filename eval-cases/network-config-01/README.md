# network-config-01: Network Configuration Migration

| | |
|---|---|
| Case ID | `network-config-01` |
| Case version | `10` |
| Scoring standard | Rubric v0.2 (`rubric.json`) |
| Written for | `arbitrum-docs` and `arbitrum-network` (the skill is chosen with `--skill` at run time) |
| Committed runs | `20260924T151721Z-bfb34c20` (arbitrum-docs), `20260924T170734Z-b115674e` (arbitrum-network) |

## 1. Why this case exists

It measures whether a skill, together with any MCP servers the skill declares, helps an agent migrate an application's network configuration correctly. Both arms use the same model and thinking level. The baseline has no skill. The treatment has a frozen copy of the skill. The score difference is the observed effect of the skill on this one task. It is not a general quality rating of the skill.

## 2. The task

The agent receives this prompt, verbatim from `case.json`:

> Migrate this app’s production and staging network configuration in config.json from Ethereum to Arbitrum. Production should target Arbitrum One and staging should target Arbitrum Sepolia. Update the network identities, public RPC and explorer endpoints, sequencer routing and submission policy, withdrawal finality and force-inclusion settings, canonical bridge onboarding settings, and WETH/USDC token identities needed for the migration. Preserve unrelated application settings and configuration structure.

- **Allowed tools:** `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.
- **Output:** the edited `config.json` in the workspace (`outputPath`).
- **Starting files:** `fixture/config.json`, a treasury console configuration. Under `networkConfig.environments.production` and `.staging` it holds `chain`, `rpcPolicy`, `contracts`, `tokens`, `assetOnboarding` and `finalityPolicy`, all pointing at Ethereum Mainnet and Ethereum Sepolia. Outside `networkConfig` it holds unrelated settings (`application`, `wallet`, `retry`).

Unhappy paths of this task (invalid starting input, a token that must stay `null`) are described in [Additional context](#6-additional-context-optional).

## 3. How to run it

From the repository root, with credentials in `.env`. Use any skill directory as `<path_to_skill>`. To reproduce a committed run, use its frozen copy at `runs/<run-id>/inputs/frozen/skill/`.

```bash
pnpm eval -- --case network-config-01 \
  --skill <path_to_skill> \
  --model gemini-3.8-flash --limit wallClockMs=300000
pnpm eval:export -- --receipt eval-cases/network-config-01/runs/<run-id>/receipt.json   # regenerate the reports
```

Before a paid run, `pnpm eval:validate -- --case network-config-01 --skill <path_to_skill>` checks the inputs offline and `pnpm eval:doctor -- --model gemini-3.8-flash` checks readiness. `pnpm test:eval-cases` runs the validator tests. The root README explains inspection.

## 4. Scoring rubric

The rubric turns the task into a score. **Accuracy** (100 points) has two groups:

- **`outcome` (80 points):** did the agent deliver everything the task asked for? Here: 16 checks, 8 topics × 2 environments (production and staging), 5 points each. Checks of the same display topic are shown together in reports (10 points per topic).
- **`constraints` (20 points):** did the agent stay inside the task boundaries and preserve what must not change? Here: `json-shape` and `preservation`, 10 points each.

Each check earns its full points or 0, and a check that groups several assertions passes only if all of them hold. Failed checks keep their weight; missing evidence never reweights the score. The weights must stay in step with `rubric.json` and `validator.ts`. Exact passing conditions are in [Additional context](#6-additional-context-optional).

| Check ID | Display topic | Group | Points | Evidence inspected |
|---|---|---|---:|---|
| `json-shape` | Constraints and preservation | `constraints` | 10 | Candidate output JSON parsed against fixture JSON |
| `preservation` | Constraints and preservation | `constraints` | 10 | Values across all non-mutable paths compared between candidate and fixture |
| `production-chain-identity` | Correct network identities | `outcome` | 5 | `chain` object in production |
| `staging-chain-identity` | Correct network identities | `outcome` | 5 | `chain` object in staging |
| `production-legacy-fallback` | Legacy RPC fallback configuration | `outcome` | 5 | `chain` object in production |
| `staging-legacy-fallback` | Legacy RPC fallback configuration | `outcome` | 5 | `chain` object in staging |
| `production-rpc-endpoints` | Public RPC and explorer endpoints | `outcome` | 5 | `rpcPolicy` endpoint keys in production |
| `staging-rpc-endpoints` | Public RPC and explorer endpoints | `outcome` | 5 | `rpcPolicy` endpoint keys in staging |
| `production-sequencer-policy` | Sequencer routing and submission policy | `outcome` | 5 | `rpcPolicy` policy keys in production |
| `staging-sequencer-policy` | Sequencer routing and submission policy | `outcome` | 5 | `rpcPolicy` policy keys in staging |
| `production-token-identity` | WETH and USDC token identities | `outcome` | 5 | `tokens` object in production |
| `staging-token-identity` | WETH and USDC token identities | `outcome` | 5 | `tokens` object in staging |
| `production-bridge-addresses` | Canonical bridge addresses | `outcome` | 5 | Resolved across accepted alias paths for each bridge contract |
| `staging-bridge-addresses` | Canonical bridge addresses | `outcome` | 5 | Resolved across accepted alias paths for each bridge contract |
| `production-bridge-onboarding` | Bridge onboarding configuration | `outcome` | 5 | `assetOnboarding` object in production |
| `staging-bridge-onboarding` | Bridge onboarding configuration | `outcome` | 5 | `assetOnboarding` object in staging |
| `production-finality-policy` | Withdrawal finality and force-inclusion settings | `outcome` | 5 | `finalityPolicy` object in production |
| `staging-finality-policy` | Withdrawal finality and force-inclusion settings | `outcome` | 5 | `finalityPolicy` object in staging |

## 5. Provenance

The reference answers in `oracle.json` come from these sources. The oracle stays hidden from the agent.

| Source | Fields | Checked on |
|---|---|---|
| [Arbitrum chain info](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info): Arbitrum One and Arbitrum Sepolia chain, RPC, sequencer behavior, finality parameters, WETH and bridge configuration | `chainIdentity`, `rpcPolicy`, `legacyNetworkFallback`, `sequencerPolicy`, `finalityPolicy`, `wrappedNativeTokens`, `bridgeOnboarding` | 2026-08-31 |
| [Circle USDC contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses): Arbitrum One and Arbitrum Sepolia | `nativeUsdcTokens` | 2026-08-04 |
| [USDC on Arbitrum One](https://docs.arbitrum.io/arbitrum-bridge/usdc-arbitrum-one): USDC vs USDC.e table | `bridgedUsdcEToken` | 2026-08-04 |

Grading details that depend on these sources, such as the exact addresses and token handling, are in [Additional context](#6-additional-context-optional).

## 6. Additional context (optional)

### Unhappy paths

- The two `legacy-fallback` checks: the starting config points at retired Goerli endpoints (invalid input). The agent must remove them rather than migrate them.
- Staging `USDC.e` must stay `null`. A nonexistent token must not be invented. It is scored inside `staging-token-identity`.

### Accepted variants

These differences are harmless and still pass:

- Bridge contract addresses at any of the accepted alias paths, as long as every populated alias agrees with the oracle (see [bridge addresses](#alias-tolerant-bridge-addresses-vs-strict-json-shape)).
- Trailing slashes on URLs.
- Address letter case (EIP-55 checksums are accepted, not required).
- `preferredRoute` spelled `"canonicalBridge"` or `"canonical-bridge"`.
- `deprecatedGoerliFallbackUrl` set to `null` or removed.
- Key order and whitespace.

These must stay exact: chain ids and names, token addresses, the accepted sequencer method set, the finality numbers, and the canonical key names under `assetOnboarding.canonicalBridge.contracts` (needed for `json-shape`).

### Preservation

`preservation` compares parsed JSON values (`isDeepStrictEqual`; formatting, whitespace and key order are irrelevant) against the fixture for every non-mutable path: `application.*`, `wallet.*`, `retry.*`, `networkConfig.defaultEnvironment` and `environments.*.contracts.multicall3`. It guards against unwanted edits to this file only; it does not assess permissions or runtime access controls.

### Token identities

`tokens` holds `WETH`, `USDC` and `USDC.e`. Addresses compare case-insensitively (EIP-55 accepted, not required).

| Token | Production (Arbitrum One) | Staging (Arbitrum Sepolia) |
|---|---|---|
| `WETH` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73` |
| `USDC` (native, Circle) | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| `USDC.e` (bridged) | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` | `null` (no canonical USDC.e exists; any value fails) |

### Endpoint locations

URLs are compared after normalization (protocol check, trailing slash removed).

| Path in each environment | Key | Check | Example (production) |
|---|---|---|---|
| `chain` | `rpcUrl`, `explorerUrl` | `chain-identity` | `https://arb1.arbitrum.io/rpc`, `https://arbiscan.io` |
| `chain` | `deprecatedGoerliFallbackUrl` | `legacy-fallback` | `null` or removed; no Goerli reference anywhere in `chain` |
| `rpcPolicy` | `readRpcUrl`, `writeRpcUrl` | `rpc-endpoints` | public RPC |
| `rpcPolicy` | `sequencerSubmissionUrl` | `rpc-endpoints` | `https://arb1-sequencer.arbitrum.io/rpc` |

### Alias-tolerant bridge addresses vs. strict JSON shape

`bridge-addresses` accepts the contracts at any of these paths: `assetOnboarding.canonicalBridge.contracts.<key>` (canonical), `assetOnboarding.canonicalBridge.<key>`, `contracts.<key>`, or `bridgeContracts.<name>` with `parentL1GatewayRouter`, `childL2GatewayRouter`, `parentL1Erc20Gateway`, `parentOutbox`. The spellings `l1Erc20Gateway`/`l1ERC20Gateway` and `l1Outbox`/`outbox` are accepted. Every key must resolve, every populated path must match the oracle, and conflicting aliases fail.

`json-shape` is strict: the contracts must sit in `assetOnboarding.canonicalBridge.contracts` with the canonical keys `l1GatewayRouter`, `l2GatewayRouter`, `l1Erc20Gateway`, `l1Outbox`.

## 7. Results

Each committed run folder holds its sealed evidence plus a generated `EVALS.md` (the file to share) and `EVALS-FULL-REPORT.md`. Regenerate them with `pnpm eval:export -- --receipt <receipt>`.

| Run | Skill | Pairs | Accuracy | Tokens | Latency |
|---|---|---:|---|---|---|
| [`20260924T151721Z-bfb34c20`](runs/20260924T151721Z-bfb34c20/EVALS-FULL-REPORT.md) | `arbitrum-docs` | 3 | 40% → 80% | −32.2% | −21.1% |
| [`20260924T170734Z-b115674e`](runs/20260924T170734Z-b115674e/EVALS-FULL-REPORT.md) | `arbitrum-network` | 3 | 48.3% → 80% | −98.1% | −82.2% |

Values are means over the pairs and are copied from each run's `EVALS.md`; the generated reports are authoritative. Verify a run with `pnpm eval:report -- --receipt eval-cases/network-config-01/runs/<run-id>/receipt.json --checks`. Never edit sealed files under `runs/`.
