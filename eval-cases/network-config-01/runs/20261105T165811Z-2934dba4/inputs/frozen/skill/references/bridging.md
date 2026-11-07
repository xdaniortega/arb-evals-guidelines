# Canonical bridging

## Arbitrum Gotchas

- When the target network is ambiguous, default to Arbitrum Sepolia (421614).
- Never write a private key into generated code, config, or output. Use environment variables, wallet clients, or placeholders.
- Never invent a contract address. Read references/addresses.md, or state that it needs to be looked up.
- Account for both L2 execution gas and the L1 data fee when estimating Arbitrum transaction cost.
- Sequencer endpoints are submission-only. Use a normal RPC or node provider for reads.
- Withdrawals from Arbitrum to Ethereum are not instant. Say so whenever bridging out comes up.
- Do not prepare or broadcast a mainnet transaction that moves funds, changes approvals, or changes contract state until the user explicitly approves the final preflight summary.

Addresses in [addresses.md](addresses.md). Chain parameters source: https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info

**Withdrawals to L1 are not instant.** Every withdrawal waits out the dispute (challenge) window before it can be executed on L1:

| Chain | Challenge window |
| --- | --- |
| Arbitrum One | 45818 blocks, ~6.4 days |
| Arbitrum Sepolia | 20 blocks, ~4 minutes |

Anything that promises instant exit is a third-party liquidity bridge, not the canonical bridge, and carries its own trust assumptions.

## Deposit ERC-20 (L1 -> L2) via the Gateway Router

1. Look up the token's gateway: `L1GatewayRouter.getGateway(token)`. Most tokens use the default L1 ERC20 Gateway; some (e.g. custom tokens) have their own.
2. Approve **the gateway** (not the router) to spend the token.
3. Call `L1GatewayRouter.outboundTransfer(token, to, amount, maxGas, gasPriceBid, data)` with enough ETH to cover the retryable ticket submission cost. Estimate with `NodeInterface.estimateRetryableTicket` (see [gas-fees.md](gas-fees.md)).
4. The deposit executes on L2 as a retryable ticket, typically within minutes. If auto-redeem fails, the ticket can be redeemed manually via `ArbRetryableTx.redeem` before it expires (~7 days, see https://docs.arbitrum.io/how-arbitrum-works/deep-dives/l1-to-l2-messaging).

Method names verified from https://github.com/OffchainLabs/token-bridge-contracts (GatewayRouter.sol, L1GatewayRouter.sol). The Arbitrum SDK (`@arbitrum/sdk` `Erc20Bridger`) wraps all of this and is the recommended path in application code.

## L1-to-L2 address aliasing

When an L1 contract sends an unsigned delayed inbox message or creates a retryable ticket, its L2 `msg.sender` is not the raw L1 contract address. It is the aliased address:

```text
L2 alias = L1 contract address + 0x1111000000000000000000000000000000001111
```

This matters for refund recipients:

- If `excessFeeRefundAddress` or `callValueRefundAddress` points to an L1 contract, the usable L2 refund address is normally the aliased address, not the raw L1 address.
- EOAs are not aliased for signed messages. Do not apply the offset blindly to normal EOA wallet addresses.
- Prefer Arbitrum SDK helpers or `AddressAliasHelper`/ArbSys alias methods rather than hand-rolling address arithmetic in application code.
- If the prompt names an L1 contract as the refund recipient, stop and account for aliasing before giving final calldata or operational instructions.

Using the raw L1 contract address for an L2 refund can strand funds at an address that the intended L1 contract does not control on L2.

## Deposit ETH (L1 -> L2)

Send ETH to the Delayed Inbox `depositEth()`. The Arbitrum SDK's `EthBridger` wraps this.

## Withdraw (L2 -> L1)

1. **Initiate on L2.**
   - ETH: `ArbSys.withdrawEth(destination)` with the amount as call value.
   - ERC-20: `L2GatewayRouter.outboundTransfer(l1Token, to, amount, data)`.
   - Under the hood both produce an L2-to-L1 message via `ArbSys.sendTxToL1(destination, data)` (ArbSys: `0x0000000000000000000000000000000000000064`, source: https://github.com/OffchainLabs/nitro-precompile-interfaces/blob/main/ArbSys.sol).
2. **Wait out the challenge window** (table above).
3. **Execute on L1** by calling `Outbox.executeTransaction` with a Merkle proof from `NodeInterface.constructOutboxProof` (via `eth_call`). The Arbitrum SDK's `ChildToParentMessage.execute` handles proof construction and execution.

Funds arrive on L1 only after step 3. Step 3 costs L1 gas and anyone can execute it once the window has passed.

## Force inclusion (sequencer censorship escape hatch)

If the sequencer never includes a transaction, submit it through the L1 Delayed Inbox. After the force-include period (5760 blocks, 24 hours) anyone can call `SequencerInbox.forceInclusion` on L1 to include it without sequencer cooperation. This is the mechanism that keeps the sequencer trust-minimized.
