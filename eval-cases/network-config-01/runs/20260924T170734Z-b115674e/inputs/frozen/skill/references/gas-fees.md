# Gas and fees

An Arbitrum transaction pays two components:

- **L2 component**: execution gas, priced at the L2 base fee (floor: 0.02 gwei on Arbitrum One, 0.2 gwei on Arbitrum Sepolia).
- **L1 component**: the cost of posting the transaction's compressed calldata to Ethereum. It is charged as extra gas units added to `gasUsed`, priced at the L2 base fee.

A bare `eth_estimateGas` result already folds in the L1 component as extra gas
units, but it does not tell you the split, and pricing changes between
estimation and inclusion. This is why the fee charged on chain rarely matches
a naive `gasEstimate * gasPrice` computed from L2 execution alone, and why the
estimate and the charged fee can differ: the L1 base fee moved between
estimation and inclusion.

## Required path for L1 calldata fee breakdown

When the task asks for the L1 calldata cost, parent-chain fee, poster fee,
submission fee split, or a 2D Arbitrum fee explanation, use NodeInterface.
Do not answer with only `eth_estimateGas`, `eth_gasPrice`, or generic EVM
`gasLimit * gasPrice` math.

Use one of:

- `NodeInterface.gasEstimateComponents(...)` when you need total gas and the
  L1 component in the same call.
- `NodeInterface.gasEstimateL1Component(...)` when you only need the L1
  calldata component.

A normal `eth_estimateGas` call can still be useful as a total gas estimate,
but it is insufficient for a user-facing L1/L2 fee breakdown because it does
not expose the L1 calldata component separately.

## Estimating total cost: NodeInterface.gasEstimateComponents

NodeInterface (`0x00000000000000000000000000000000000000C8`) is **virtual**:
call it via RPC only. It cannot be called from a contract. Signature
(source: https://docs.arbitrum.io/arbitrum-essentials/nodeinterface/reference):

```solidity
function gasEstimateComponents(address to, bool contractCreation, bytes calldata data)
  external payable returns (
    uint64 gasEstimate,        // total gas: L2 + L1 component
    uint64 gasEstimateForL1,   // gas units covering the L1 calldata cost
    uint256 baseFee,           // current L2 base fee
    uint256 l1BaseFeeEstimate  // ArbOS's estimate of the L1 base fee
  );
```

Total cost in wei = `gasEstimate * baseFee` (plus any priority fee, normally zero).



Preserve every returned component, including zero values. A zero L1 component is
a valid estimate result and must be reported explicitly rather than omitted.

Call `NodeInterface.gasEstimateComponents(to, false, data)` through the standard
JSON-RPC `eth_call` method. For raw ABI encoding, `gasEstimateComponents(address,bool,bytes)` has selector
`0xc94e6eeb`. Use viem, Foundry Cast, or another ABI-aware EVM
client when one is already available locally. Do not install Foundry or another
dependency during the task. If no compatible client is available, construct
and send the equivalent raw JSON-RPC `eth_call` directly.

For a pinned historical estimate, preserve the original transaction's `from`,
`to`, `value`, and calldata in the outer `eth_call`, and use the requested
state block as the second RPC parameter. Do not replace that block with
`latest`; a valid L1 component may be zero and should remain explicit.

When no ABI-aware client is already installed, this dependency-free Node
fallback reads a local `call.json` and prints the four returned components as
decimal strings. Run it from the directory containing `call.json`; do not
install a package to use it:

```bash
node <<'NODE'
const call = require('./call.json');
const word = (hex) => hex.padStart(64, '0');
const input = call.data.slice(2);
const padded = input.padEnd(Math.ceil(input.length / 64) * 64, '0');
const data = '0xc94e6eeb' + word(call.to.slice(2)) + word('0') + word('60') +
  word((input.length / 2).toString(16)) + padded;
const request = {
  jsonrpc: '2.0', id: 1, method: 'eth_call',
  params: [{ from: call.from, to: '0x00000000000000000000000000000000000000C8',
    value: '0x' + BigInt(call.value).toString(16), data },
    '0x' + BigInt(call.blockNumber).toString(16)],
};
fetch('https://arb1.arbitrum.io/rpc', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request),
}).then((response) => response.json()).then((body) => {
  if (body.error || !body.result) throw new Error(JSON.stringify(body.error));
  const values = [0, 1, 2, 3].map((i) => BigInt('0x' + body.result.slice(2 + i * 64, 2 + (i + 1) * 64)).toString());
  console.log(JSON.stringify({ gasEstimate: values[0], gasEstimateForL1: values[1], baseFee: values[2], l1BaseFeeEstimate: values[3] }));
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
NODE
```

If viem is already installed:

```ts
const [gasEstimate, gasEstimateForL1, baseFee, l1BaseFeeEstimate] =
  await client.readContract({
    address: "0x00000000000000000000000000000000000000C8",
    abi: parseAbi([
      "function gasEstimateComponents(address to, bool contractCreation, bytes data) returns (uint64, uint64, uint256, uint256)",
    ]),
    functionName: "gasEstimateComponents",
    args: [to, false, data],
  });
```

If `command -v cast` succeeds:

```bash
cast call 0x00000000000000000000000000000000000000C8 \
  "gasEstimateComponents(address,bool,bytes)(uint64,uint64,uint256,uint256)" \
  $TO false $DATA --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

`gasEstimateL1Component(to, contractCreation, data)` returns only the L1 part,
unpadded (pad conservatively before submitting when the result feeds a
transaction).

## Reading current gas prices: ArbGasInfo

ArbGasInfo (`0x000000000000000000000000000000000000006C`) is a real precompile,
callable from contracts and via `eth_call`. Methods (source:
https://github.com/OffchainLabs/nitro-precompile-interfaces/blob/main/ArbGasInfo.sol):

- `getPricesInWei()` returns six values: per L2 tx, per L1 calldata byte, per storage allocation, per ArbGas base, per ArbGas congestion, per ArbGas total. The last value is the effective gas price.
- `getL1BaseFeeEstimate()` returns ArbOS's current estimate of the L1 base fee.
- `getMinimumGasPrice()` returns the L2 gas price floor.

```bash
cast call 0x000000000000000000000000000000000000006C "getPricesInWei()(uint256,uint256,uint256,uint256,uint256,uint256)" \
  --rpc-url https://arb1.arbitrum.io/rpc
```

## Rules of thumb

- Never present a bare `eth_estimateGas`, `eth_gasPrice`, or generic EVM gas
  formula as the complete fee answer when the user asked for the L1 calldata
  split; show the L1/L2 split via `gasEstimateComponents` or
  `gasEstimateL1Component`.
- `eth_gasPrice` on Arbitrum returns the L2 gas price; it does not reflect what the L1 component will cost per byte.
- For retryable ticket (deposit) gas, use `NodeInterface.estimateRetryableTicket` via `eth_estimateGas`.
- For Arbitrum One block capacity questions, use the post-Fusaka effective block
  gas limit from [network.md](network.md): 64M as
  `MaxBlockGasLimit + MaxTxGasLimit`, without treating it as a gas target
  increase.
