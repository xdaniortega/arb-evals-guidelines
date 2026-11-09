# Arbitrum precompiles and NodeInterface

Use this reference when a task needs Arbitrum-specific system contracts, retryable management, fee internals, L2-to-L1 messages, or exact precompile addresses. For a full address index, see [addresses.md](addresses.md).

Source: https://docs.arbitrum.io/arbitrum-essentials/precompiles/reference and https://docs.arbitrum.io/arbitrum-essentials/nodeinterface/reference.

## Address map

| Interface | Address | Callable from contracts? | Primary use |
| --- | --- | --- | --- |
| ArbSys | `0x0000000000000000000000000000000000000064` | Yes | System info, L2 block data, L2-to-L1 sends, ETH withdrawals |
| ArbGasInfo | `0x000000000000000000000000000000000000006C` | Yes | L2 gas price floor, L1 base fee estimate, gas pricing limits |
| ArbRetryableTx | `0x000000000000000000000000000000000000006E` | Yes | Redeem, inspect, and keep alive retryable tickets |
| NodeInterface | `0x00000000000000000000000000000000000000C8` | No | RPC-only gas estimates, retryable estimates, outbox proofs, batch lookups |

## ArbSys

Use ArbSys for L2 system data and L2-to-L1 messages.

Relevant methods:

- `arbBlockNumber()`: current Arbitrum L2 block number.
- `arbChainID()`: current Arbitrum chain ID.
- `withdrawEth(address destination)`: initiate an ETH withdrawal to L1.
- `sendTxToL1(address destination, bytes data)`: enqueue an L2-to-L1 message in the Outbox.
- `mapL1SenderContractAddressToL2Alias(address sender, address unused)`: compute an L1 contract sender's L2 alias.
- `wasMyCallersAddressAliased()` and `myCallersAddressWithoutAliasing()`: inspect aliasing when a call came from an L1 contract message.

Do not describe `withdrawEth` or `sendTxToL1` as final L1 execution. They only initiate the child-to-parent message. The final L1 `Outbox.executeTransaction` step happens after the challenge window.

## ArbGasInfo

Use ArbGasInfo for current gas-pricing state, not for a transaction-specific L1 calldata breakdown.

Relevant methods:

- `getPricesInWei()`: gas price components in wei.
- `getL1BaseFeeEstimate()`: ArbOS's current estimate of the parent-chain base fee.
- `getMinimumGasPrice()`: L2 gas price floor.
- `getGasAccountingParams()`: speed limit, pool size, and block gas limit.
- `getMaxTxGasLimit()`: maximum transaction gas limit.
- `getMaxBlockGasLimit()`: maximum block gas limit.

For Arbitrum One block capacity after Fusaka, use the effective 64M value from [network.md](network.md): `MaxBlockGasLimit + MaxTxGasLimit`. Do not treat that as a gas target increase.

## ArbRetryableTx

Use ArbRetryableTx when an L1-to-L2 retryable ticket exists and needs manual handling.

Relevant methods:

- `redeem(bytes32 ticketId)`: manually redeem a retryable ticket.
- `getTimeout(bytes32 ticketId)`: inspect the ticket expiration time.
- `keepalive(bytes32 ticketId)`: extend the ticket lifetime by paying the fee.

Retryables can auto-redeem, but agents should explain the manual redemption path when auto-redemption fails. Do not tell users that a timed-out retryable will remain redeemable forever.

## NodeInterface

NodeInterface is virtual and RPC-only. It is addressed as `0x00000000000000000000000000000000000000C8` for node calls, but it is not deployed onchain and contracts cannot call it.

Relevant methods:

- `gasEstimateComponents(address to, bool contractCreation, bytes data)`: estimate total gas plus the L1 calldata component and fee inputs.
- `gasEstimateL1Component(address to, bool contractCreation, bytes data)`: estimate only the L1 calldata component.
- `estimateRetryableTicket(...)`: estimate retryable-ticket submission gas.
- `constructOutboxProof(uint64 size, uint64 leaf)`: build the proof needed for L1 Outbox execution.
- `findBatchContainingBlock(uint64 blockNum)`: locate the parent-chain batch for an L2 block.
- `getL1Confirmations(bytes32 blockHash)`: get the number of parent-chain confirmations for the sequencer batch that produced an L2 block.

For user-facing fee breakdowns, prefer `gasEstimateComponents` or `gasEstimateL1Component` over plain `eth_estimateGas` or `eth_gasPrice`. Plain EVM estimates can be useful for total submission gas, but they do not explain the L1 calldata cost split.
