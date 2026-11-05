# Network reference

## Arbitrum Gotchas

- When the target network is ambiguous, default to Arbitrum Sepolia (421614).
- Never write a private key into generated code, config, or output. Use environment variables, wallet clients, or placeholders.
- Never invent a contract address. Read references/addresses.md, or state that it needs to be looked up.
- Account for both L2 execution gas and the L1 data fee when estimating Arbitrum transaction cost.
- Sequencer endpoints are submission-only. Use a normal RPC or node provider for reads.
- Withdrawals from Arbitrum to Ethereum are not instant. Say so whenever bridging out comes up.
- Do not prepare or broadcast a mainnet transaction that moves funds, changes approvals, or changes contract state until the user explicitly approves the final preflight summary.

Sources:
- https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info
- https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees

## Endpoints

| Chain | chainId | Public RPC | Sequencer endpoint | Sequencer feed |
| --- | --- | --- | --- | --- |
| Arbitrum One | 42161 | https://arb1.arbitrum.io/rpc | https://arb1-sequencer.arbitrum.io/rpc | wss://arb1-feed.arbitrum.io/feed |
| Arbitrum Sepolia | 421614 | https://sepolia-rollup.arbitrum.io/rpc | https://sepolia-rollup-sequencer.arbitrum.io/rpc | wss://sepolia-rollup.arbitrum.io/feed |

Do not use 421613: that was Arbitrum Goerli, which is retired. The current testnet is Arbitrum Sepolia, 421614. Arbitrum Nova (42170) is a separate AnyTrust production chain, not a testnet or a replacement for Arbitrum Sepolia.

viem ships both chains: `import { arbitrum, arbitrumSepolia } from "viem/chains"`.

## Public RPC limitations

- No uptime, latency, or rate limit guarantees. Production applications should use a node provider or run their own node.
- No websocket support and no IPv6 on the public endpoints.

## Sequencer endpoint semantics

The sequencer endpoints accept **only** `eth_sendRawTransaction` and `eth_sendRawTransactionConditional`. They are not general purpose RPCs: they cannot serve reads (`eth_call`, `eth_getBalance`, `eth_blockNumber`, etc.). Use the public RPC or a node provider for reads.

Submission behavior:

- The sequencer queues submissions in a bounded in-memory queue: default capacity 1024, default timeout 12 seconds.
- `context deadline exceeded` means the transaction was **not** accepted. It is safe to retry with backoff.
- `nonce too low` and contract reverts are terminal. Do not retry them.
- A successful `eth_sendRawTransaction` means the transaction was sequenced into an L2 block. That is a soft confirmation, not parent chain finality. For parent-chain confirmation tracking, use `NodeInterface.getL1Confirmations(bytes32 blockHash)`; see [precompiles.md](precompiles.md).

## Chain parameters

| Param | Arbitrum One | Arbitrum Sepolia |
| --- | --- | --- |
| Gas price floor | 0.02 gwei | 0.2 gwei |
| Effective block gas limit | 64,000,000 | 32,000,000 |
| Dispute (challenge) window | 45818 blocks (~6.4 days) | 20 blocks (~4 minutes) |
| Force-include period | 5760 blocks / 24 hours | 5760 blocks / 24 hours |

Chain parameters list Arbitrum One's configured `MaxBlockGasLimit` as 32M. Post-Fusaka, the effective limit is `MaxBlockGasLimit + MaxTxGasLimit` = 64M. Use 64M for capacity questions; this does not increase the gas target or gas per second.

## Docs escape hatch

For anything not covered here: https://docs.arbitrum.io/llms.txt indexes the docs, and appending `.md` to any docs URL returns markdown.
