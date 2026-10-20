---
name: arbitrum-onchain
description: Read Arbitrum chain state and prepare standard wallet RPC plans with the arb CLI — balances, contract reads/writes, gas, event logs, tx status, and canonical-bridge tracking. Use when the user says "check my balance", "read/call a contract", "cast call", "cast send", "estimate gas", "query logs/events", "tx status", "nonce", "bridge status", "is my deposit/withdrawal done", or names a token/contract on Arbitrum.
status: active
context: fork
---

# Arbitrum Onchain

Read Arbitrum state and build signing plans for the user's wallet. **This toolset never signs
or holds keys** — write commands return a versioned `arb.wallet-plan` that an external wallet
reviews and fulfills.

## Networks

Everything defaults to **Arbitrum One**. Add `--network arbitrum-nova` or
`--network arbitrum-sepolia` to target another chain. `arb networks` lists them with RPC and
explorer URLs. Override an RPC with the env var shown by `arb networks` (e.g. `ARBITRUM_RPC_URL`).

## Reads

| Goal | Command |
|---|---|
| ETH + ERC-20 balances for an address | `arb balances <address> [--tokens WETH,USDC,…]` |
| ERC-20 balance / allowance | `arb token balance <token> <owner>` · `arb token allowance <token> <owner> <spender>` |
| ERC-721 owner + tokenURI | `arb token nft <contract> <id>` |
| ERC-1155 balance | `arb token balance1155 <contract> <owner> <id>` |
| Call any read function | `arb call <to> "<sig>" --arg <a> --arg <b>` |
| Gas snapshot + recommendation | `arb gas` |
| Event logs | `arb logs --address <c> --event "<sig>" --from-block -5000` |
| Transaction status | `arb tx status <hash>` |
| Nonce / pending diagnostics | `arb tx pending <address>` |

Notes:
- `arb call` accepts cast-style `"balanceOf(address)(uint256)"` or full
  `"function balanceOf(address) view returns (uint256)"`. Pass each argument with a repeated `--arg`.
- `arb logs` decodes event args only when the signature includes `indexed` markers, e.g.
  `"Transfer(address indexed from, address indexed to, uint256 value)"`. Use a negative
  `--from-block` (e.g. `-5000`) for "last N blocks".

## Preparing wallet plans

Every write command prints `mode: present` with one standard RPC request at
`walletPlan.request`. Most writes use EIP-5792 `wallet_sendCalls`; transaction replacement uses
`eth_sendTransaction`. Command-specific simulation and explanatory fields live in top-level
`context`. Hand only the request to the user's wallet and never claim you executed anything.
`arb wallet schema` prints the machine-readable contract.

| Goal | Command |
|---|---|
| ERC-20 approve (bounded) | `arb token approve <token> <spender> <amount>` |
| ERC-20 transfer | `arb token transfer <token> <to> <amount>` |
| Any contract write | `arb send <to> "<sig>" --arg <a> --from <you> [--value <wei>]` |
| Speed up / cancel a stuck tx | `arb tx replace <hash> --mode speedup\|cancel` |

Pass `--from <the user's address>` to `send` (required) so the simulation is accurate; inspect
`context.simulation.status` (`success`/`failure`) before recommending fulfillment.
`arb decode <to> <data>` explains any calldata and flags risks (unlimited approval, etc.).

## Bridge status

`arb bridge status <txHash>` traces a canonical transfer:
- **Deposit (L1→L2)**: reports each retryable ticket's status. `FUNDS_DEPOSITED_ON_CHILD` means
  the auto-redeem failed and the ticket must be manually redeemed on L2.
- **Withdrawal (L2→L1)**: reports the Outbox status — `UNCONFIRMED` (inside the ~7-day window),
  `CONFIRMED` (ready to execute on L1), or `EXECUTED`.

Resolving withdrawal Outbox status needs an **archive-capable L1 RPC**: set `ETHEREUM_RPC_URL`
to an Alchemy/Infura/QuickNode endpoint. Without it the command still detects the message but
reports `UNKNOWN` with that guidance.

## Guardrails

- Never present a write as executed. Say "here is the wallet plan to review and fulfill."
- Read the simulation before recommending a signature; if it failed, explain why and stop.
- For "best"/"safe" judgments, defer to `arb safety <token>` and state tradeoffs, not absolutes.
- Confirm the network with the user when preparing a value-moving transaction off Arbitrum One.
