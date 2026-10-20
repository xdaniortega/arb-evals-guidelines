---
name: arbitrum-network
description: >
  Use this skill when building, debugging, or answering Arbitrum-specific tasks
  for Arbitrum One or Arbitrum Sepolia: chain IDs, RPC URLs, sequencer
  submission behavior, retry rules, precompile addresses, token addresses, token balances, gas estimation with the L1 data fee component,
  canonical bridge deposits or withdrawals, challenge windows, Arbiscan,
  Blockscout, contract verification, contract reads or writes, ERC-20
  approvals, transaction simulation, or safe transaction preflights. Prefer
  this skill whenever generic EVM assumptions may be wrong on Arbitrum.
metadata:
  author: daniel@arbitrum.foundation
  version: "0.2.1"
  af-evals: "PASS"
---

# Arbitrum Network

## Purpose

Use this skill for Arbitrum-specific facts and recipes that generic EVM
knowledge often gets wrong: two-component gas fees, sequencer submission
semantics, delayed withdrawals, and addresses that should not be guessed.

## Network Defaults

| Chain | chainId | Public RPC | Explorer |
| --- | --- | --- | --- |
| Arbitrum One | 42161 | https://arb1.arbitrum.io/rpc | https://arbiscan.io |
| Arbitrum Sepolia | 421614 | https://sepolia-rollup.arbitrum.io/rpc | https://sepolia.arbiscan.io |

Source: https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info.

## Arbitrum Gotchas

- When the target network is ambiguous, default to Arbitrum Sepolia (421614).
- Never write a private key into generated code, config, or output. Use environment variables, wallet clients, or placeholders.
- Never invent a contract address. Read the reference file for it, or state that it needs to be looked up.
- Account for both L2 execution gas and the L1 data fee when estimating Arbitrum transaction cost.
- Sequencer endpoints are submission-only. Use a normal RPC or node provider for reads.
- Withdrawals from Arbitrum to Ethereum are not instant. Say so whenever bridging out comes up.
- Do not prepare or broadcast a mainnet transaction that moves funds, changes approvals, or changes contract state until the user explicitly approves the final preflight summary.

## Action Protocol

Use this protocol before recommending or preparing Arbitrum transactions:

1. Identify the chain, user intent, contract, token, account, and whether the task is a read, simulation, approval, bridge, or state-changing write.
2. Verify the chain ID, RPC, target address, deployed bytecode, ABI/source, token identity, spender, value, calldata intent, and expected post-state.
3. Simulate writes with the user's account and exact arguments before any broadcast. For fee-sensitive transactions, include the L1 data fee component.
4. Ask for explicit approval before any irreversible mainnet action, including approvals and transactions that move funds.
5. Execute only after approval, using the verified chain and wallet flow. Prefer SDKs for canonical bridge flows.
6. Confirm with the transaction receipt, status, logs, explorer link, and any Arbitrum-specific finality caveat.
7. Report what happened, what remains pending, and any follow-up the user must perform.

## Reference Map

Read only the file needed for the task:

- [references/network.md](references/network.md): chain IDs, RPC URLs, sequencer submissions, retries, finality, and public RPC limitations.
- [references/addresses.md](references/addresses.md): address index for tokens, gateway routers, bridge contracts, precompiles, and multicall.
- [references/precompiles.md](references/precompiles.md): operational use of ArbSys, ArbGasInfo, ArbRetryableTx, and NodeInterface.
- [references/gas-fees.md](references/gas-fees.md): Arbitrum fee math, L1 data fee split, NodeInterface estimates, ArbGasInfo, and post-Fusaka gas limits.
- [references/contract-interactions.md](references/contract-interactions.md): contract reads, writes, approvals, simulations, ABI/source checks, explorer validation, and user approval preflights.
- [references/bridging.md](references/bridging.md): canonical deposits, withdrawals, retryables, challenge windows, and force inclusion.
- [references/explorer.md](references/explorer.md): Arbiscan, Blockscout, API URLs, and verification flows.

## Documentation Fallback

If local references do not cover the task, fetch
https://docs.arbitrum.io/llms.txt for the docs index (or `/llms-full.txt` for
everything), and append `.md` to any Arbitrum docs URL to get the markdown
version of that page.
