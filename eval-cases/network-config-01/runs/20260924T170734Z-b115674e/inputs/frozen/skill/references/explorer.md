# Explorers

## Which explorer for which chain

| Chain | Arbiscan (web) | Blockscout (web) |
| --- | --- | --- |
| Arbitrum One | https://arbiscan.io | https://arbitrum.blockscout.com |
| Arbitrum Sepolia | https://sepolia.arbiscan.io | https://arbitrum-sepolia.blockscout.com |

Source: https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info

## Arbiscan API (Etherscan V2, key required)

The per-chain Arbiscan V1 API (`https://api.arbiscan.io/api`) was retired on
2025-08-15. Do not generate code against it. All chains now share the
Etherscan V2 endpoint, selected by `chainid`:

```
https://api.etherscan.io/v2/api?chainid=42161&module=account&action=balance&address=0x...&apikey=KEY
```

- Arbitrum One: `chainid=42161`. Arbitrum Sepolia: `chainid=421614`.
- One API key (from https://etherscan.io) works across all chains. A key is required; free tier is rate limited (~3 req/s).
- `module`/`action` parameters are unchanged from the old Arbiscan API.

Source: https://docs.etherscan.io (Etherscan V2 migration).

## Blockscout API (no key required)

Blockscout exposes an Etherscan-compatible API and a REST API without an API
key, which makes it the better default for agents and scripts:

```
https://arbitrum.blockscout.com/api?module=account&action=balance&address=0x...
https://arbitrum.blockscout.com/api/v2/addresses/0x...
```

Sepolia equivalent: `https://arbitrum-sepolia.blockscout.com/api/...`

## Contract verification

- Arbiscan: standard Etherscan flow. Foundry: `forge verify-contract --chain-id 421614 --verifier etherscan <address> <contract>` with `ETHERSCAN_API_KEY` set; hardhat-verify works with `customChains` pointing at the V2 endpoint.
- Blockscout: `forge verify-contract --verifier blockscout --verifier-url https://arbitrum-sepolia.blockscout.com/api/ <address> <contract>` (no key).
- Verify on the explorer matching the chain: a Sepolia contract is verified on sepolia.arbiscan.io / arbitrum-sepolia.blockscout.com, never on the mainnet explorer.
