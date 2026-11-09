# Address index

Precompile and bridge addresses source: https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info

Use this file for exact addresses. For how to use ArbSys, ArbGasInfo, ArbRetryableTx, or NodeInterface safely, read [precompiles.md](precompiles.md).

## Precompiles and NodeInterface

| Precompile | Address | What it does | When an agent needs it |
| --- | --- | --- | --- |
| ArbSys | `0x0000000000000000000000000000000000000064` | System info and L2-to-L1 messaging | Withdrawals; L2 block/chain data; alias helpers |
| ArbInfo | `0x0000000000000000000000000000000000000065` | Account balance and code queries | Rarely; standard RPCs cover this |
| ArbAddressTable | `0x0000000000000000000000000000000000000066` | Register addresses as integers to compress calldata | Calldata cost optimization |
| ArbFunctionTable | `0x0000000000000000000000000000000000000068` | Legacy function table support | Not needed in new code (classic-era) |
| ArbOwnerPublic | `0x000000000000000000000000000000000000006b` | Read chain owner set and settings | Verifying chain governance parameters |
| ArbGasInfo | `0x000000000000000000000000000000000000006C` | Gas pricing data | Current L1/L2 gas state; see [precompiles.md](precompiles.md) |
| ArbAggregator | `0x000000000000000000000000000000000000006D` | Aggregator (batch poster) config | Chain operators only |
| ArbRetryableTx | `0x000000000000000000000000000000000000006E` | Retryable ticket management | Redeem, inspect, or keep alive failed L1-to-L2 tickets |
| ArbStatistics | `0x000000000000000000000000000000000000006F` | Pre-Nitro chain statistics | Rarely; historical data |
| ArbOwner | `0x0000000000000000000000000000000000000070` | Chain owner administration | Chain operators only; calls revert for non-owners |
| ArbWasm | `0x0000000000000000000000000000000000000071` | Stylus (WASM) program management | Deploying/activating Stylus contracts |
| ArbWasmCache | `0x0000000000000000000000000000000000000072` | Stylus program cache management | Stylus cache operations |
| NodeInterface | `0x00000000000000000000000000000000000000C8` | Virtual RPC-only interface | Fee estimation and withdrawal proofs; see [precompiles.md](precompiles.md) |

NodeInterface is listed here because agents often need its address, but it is not a deployed precompile. Contracts cannot call it.

## Tokens

| Token | Chain | Address | Decimals | Notes |
| --- | --- | --- | --- | --- |
| USDC (native, Circle-issued) | Arbitrum One | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | 6 | The canonical USDC. Prefer this unless told otherwise |
| USDC.e (bridged from Ethereum) | Arbitrum One | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` | 6 | Legacy bridged version; distinct token, do not confuse with native |
| USDC (native testnet) | Arbitrum Sepolia | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | 6 | Testnet USDC; the One address does not exist on Sepolia |
| WETH | Arbitrum One | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | 18 | |
| WETH | Arbitrum Sepolia | `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73` | 18 | |

USDC sources: https://developers.circle.com/stablecoins/usdc-contract-addresses (native, both chains); USDC.e verified via https://arbitrum.blockscout.com/token/0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8 ("Arbitrum Bridged USDC", symbol USDC.E, 6 decimals).

## Bridge contracts

| Contract | Chain it lives on | Arbitrum One | Arbitrum Sepolia |
| --- | --- | --- | --- |
| L1 Gateway Router | Ethereum / Sepolia | `0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef` | `0xcE18836b233C83325Cc8848CA4487e94C6288264` |
| L2 Gateway Router | the Arbitrum chain | `0x5288c571Fd7aD117beA99bF60FE0846C4E84F933` | `0x9fDD1C4E4AA24EEc1d913FABea925594a20d43C7` |
| L1 ERC20 Gateway (default escrow) | Ethereum / Sepolia | `0xa3A7B6F88361F48403514059F1F16C8E78d60EeC` | `0x902b3E5f8F19571859F4AB1003B960a5dF693aFF` |
| Outbox | Ethereum / Sepolia | `0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840` | `0x65f07C7D521164a4d5DaC6eB8Fac8DA067A3B78F` |

## Multicall

| Chain | L2 Multicall |
| --- | --- |
| Arbitrum One | `0x842eC2c7D803033Edf55E478F461FC547Bc54EB2` |
| Arbitrum Sepolia | `0xA115146782b7143fAdB3065D86eACB54c169d092` |

Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) is also deployed on both chains at its usual address (verified via `eth_getCode` on both public RPCs); viem's `multicall` uses it by default.
