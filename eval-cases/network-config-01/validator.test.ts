import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSnapshot, type ValidationOutcome } from "./validator.js";

const FIXTURE_PATH = fileURLToPath(new URL("./fixture/config.json", import.meta.url));
const ORACLE_PATH = fileURLToPath(new URL("./oracle.json", import.meta.url));
const RUBRIC_PATH = fileURLToPath(new URL("./rubric.json", import.meta.url));
const ENVIRONMENTS = ["production", "staging"] as const;
const CHECK_COUNT = 18;
const EXPECTED_CHECK_IDS = [
  "json-shape",
  "preservation",
  "production-chain-identity",
  "production-legacy-fallback",
  "production-sequencer-policy",
  "production-token-identity",
  "production-bridge-addresses",
  "production-bridge-onboarding",
  "production-finality-policy",
  "staging-chain-identity",
  "staging-legacy-fallback",
  "staging-sequencer-policy",
  "staging-token-identity",
  "staging-bridge-addresses",
  "staging-bridge-onboarding",
  "staging-finality-policy",
  "rpc-routing",
  "write-rpc-provider",
] as const;
const MUTATION_CASES = [
  ["chain", "chainId", "chain-identity"],
  ["rpcPolicy", "sequencerSubmissionUrl", "rpc-routing"],
  ["tokens", "USDC.e", "token-identity"],
  ["assetOnboarding", "preferredRoute", "bridge-onboarding"],
] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000001";
const IMMUTABLE_PRESERVATION_CASES = [
  ["application", "name"],
  ["wallet", "requiredConfirmations"],
  ["retry", "attempts"],
  ["networkConfig", "defaultEnvironment"],
] as const;

const IMMUTABLE_ENVIRONMENT_PRESERVATION_CASES = [
  ["contracts", "multicall3"],
] as const;

type JsonObject = Record<string, unknown>;

async function validate(workspaceRoot: string, sources: { fixturePath?: string; oraclePath?: string } = {}): Promise<ValidationOutcome> {
  const outputPath = "config.json";
  const fixtureFiles: Record<string, string> = {};
  const candidateFiles: Record<string, string> = {};
  try { fixtureFiles[outputPath] = (await readFile(sources.fixturePath ?? FIXTURE_PATH)).toString("base64"); } catch { /* pure validator reports missing trusted fixture */ }
  try { candidateFiles[outputPath] = (await readFile(resolve(workspaceRoot, outputPath))).toString("base64"); } catch { /* missing/special output is a graded zero */ }
  let oracle: unknown = {};
  try { oracle = JSON.parse(await readFile(sources.oraclePath ?? ORACLE_PATH, "utf8")); } catch { /* pure validator reports malformed trusted oracle */ }
  return validateSnapshot({ outputPath, fixtureFiles, candidateFiles, oracle });
}

async function validateWorkspace(input: { workspaceRoot: string; fixtureRoot: string; oraclePath: string; outputPath: string }): Promise<ValidationOutcome> {
  const fixtureFiles: Record<string, string> = {};
  const candidateFiles: Record<string, string> = {};
  try { fixtureFiles[input.outputPath] = (await readFile(resolve(input.fixtureRoot, input.outputPath))).toString("base64"); } catch { /* handled by validator */ }
  try { candidateFiles[input.outputPath] = (await readFile(resolve(input.workspaceRoot, input.outputPath))).toString("base64"); } catch { /* handled by validator */ }
  let oracle: unknown = {};
  try { oracle = JSON.parse(await readFile(input.oraclePath, "utf8")); } catch { /* handled by validator */ }
  return validateSnapshot({ outputPath: input.outputPath, fixtureFiles, candidateFiles, oracle });
}

test("accepts an explicit known-good generic app migration", async (context) => {
  const result = await validate(await createWorkspace(context, await knownGoodArtifact()));

  assert.equal(result.status, "graded");
  assert.equal(result.score, 1);
  assert.equal(result.fullPass, true);
  assert.deepEqual(
    result.checks.map((check) => check.id),
    [...EXPECTED_CHECK_IDS],
  );
});

test("pins rubric.json check IDs to the validator's declared check IDs", async () => {
  const rubric = JSON.parse(await readFile(RUBRIC_PATH, "utf8")) as {
    checks: Array<{ id: string }>;
  };
  assert.equal(rubric.checks.length, EXPECTED_CHECK_IDS.length);
  assert.deepEqual(
    new Set(rubric.checks.map((c) => c.id)),
    new Set(EXPECTED_CHECK_IDS),
  );
});

test("does not accept the starting Ethereum fixture", async (context) => {
  const workspace = await createEmptyWorkspace(context);
  await copyFile(FIXTURE_PATH, resolve(workspace, "config.json"));
  const result = await validate(workspace);

  assert.equal(result.status, "graded");
  assert.equal(result.score, 2 / CHECK_COUNT);
  assert.equal(result.fullPass, false);
  assertCheck(result, "json-shape", true);
  assertCheck(result, "preservation", true);
  assert.ok(
    result.checks
      .filter((check) => !check.passed)
      .every((check) => !["json-shape", "preservation"].includes(check.id)),
  );
});

for (const environment of ENVIRONMENTS) {
  for (const [group, field, checkName] of MUTATION_CASES) {
    test(`detects an independent mutation of ${environment}.${group}.${field}`, async (context) => {
      const artifact = await knownGoodArtifact();
      const target = record(environmentConfig(artifact, environment)[group]);
      target[field] = incorrectValue(target[field]);
      const result = await validate(await createWorkspace(context, artifact));

      assert.equal(result.status, "graded");
      assert.equal(result.score, (CHECK_COUNT - 1) / CHECK_COUNT);
      assert.equal(result.fullPass, false);
      assertCheck(result, checkName === "rpc-routing" ? checkName : `${environment}-${checkName}`, false);
      assertCheck(result, "json-shape", true);
      assertCheck(result, "preservation", true);
    });
  }
}

for (const environment of ENVIRONMENTS) {
  test(`requires ${environment} to clear the deprecated Goerli fallback`, async (context) => {
    const artifact = await knownGoodArtifact();
    record(environmentConfig(artifact, environment).chain).deprecatedGoerliFallbackUrl = "https://goerli.infura.io/v3/${INFURA_KEY}";
    assertOnlyCheckFails(await validate(await createWorkspace(context, artifact)), `${environment}-legacy-fallback`);
  });

  for (const [field, incorrect] of [
    ["sequencerSubmissionOnly", false],
    ["sequencerAcceptedMethods", ["eth_sendRawTransaction"]],
    ["retryableSubmissionErrors", []],
    ["terminalSubmissionErrors", ["execution reverted"]],
  ] as const) {
    test(`detects an independent mutation of ${environment}.rpcPolicy.${field}`, async (context) => {
      const artifact = await knownGoodArtifact();
      record(environmentConfig(artifact, environment).rpcPolicy)[field] = incorrect;
      assertOnlyCheckFails(await validate(await createWorkspace(context, artifact)), `${environment}-sequencer-policy`);
    });
  }

  for (const [field, incorrect] of [
    ["withdrawalsToEthereumAreInstant", true],
    ["challengeWindowBlocks", 1],
    ["forceIncludePeriodBlocks", 1],
  ] as const) {
    test(`detects an independent mutation of ${environment}.finalityPolicy.${field}`, async (context) => {
      const artifact = await knownGoodArtifact();
      record(environmentConfig(artifact, environment).finalityPolicy)[field] = incorrect;
      assertOnlyCheckFails(await validate(await createWorkspace(context, artifact)), `${environment}-finality-policy`);
    });
  }
}

test("accepts removing the deprecated Goerli fallback key outright", async (context) => {
  const artifact = await knownGoodArtifact();
  for (const environment of ENVIRONMENTS) {
    delete record(environmentConfig(artifact, environment).chain).deprecatedGoerliFallbackUrl;
  }
  const result = await validate(await createWorkspace(context, artifact));

  assert.equal(result.score, 1);
  assert.equal(result.fullPass, true);
});

test("removing a chain key other than the deprecated fallback still fails json-shape", async (context) => {
  const artifact = await knownGoodArtifact();
  delete record(environmentConfig(artifact, "production").chain).explorerUrl;
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "json-shape", false);
  assertCheck(result, "production-chain-identity", false);
  assertCheck(result, "production-legacy-fallback", true);
  assert.equal(result.fullPass, false);
});

test("rejects relocating the retired Goerli fallback to another chain field", async (context) => {
  const artifact = await knownGoodArtifact();
  const chain = record(environmentConfig(artifact, "production").chain);
  delete chain.deprecatedGoerliFallbackUrl;
  chain.deprecatedFallbackUrl = "https://goerli.infura.io/v3/${INFURA_KEY}";
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "production-legacy-fallback", false);
  assertCheck(result, "json-shape", false);
  assert.equal(result.fullPass, false);
});

test("accepts accepted sequencer methods in either order", async (context) => {
  const artifact = await knownGoodArtifact();
  for (const environment of ENVIRONMENTS) {
    record(environmentConfig(artifact, environment).rpcPolicy).sequencerAcceptedMethods = [
      "eth_sendRawTransactionConditional",
      "eth_sendRawTransaction",
    ];
  }
  const result = await validate(await createWorkspace(context, artifact));

  assert.equal(result.score, 1);
  assert.equal(result.fullPass, true);
});

for (const [label, methods] of [
  ["duplicate", ["eth_sendRawTransaction", "eth_sendRawTransaction", "eth_sendRawTransactionConditional"]],
  ["unsupported", ["eth_sendRawTransaction", "eth_sendRawTransactionConditional", "eth_call"]],
] as const) {
  test(`rejects ${label} accepted sequencer methods`, async (context) => {
    const artifact = await knownGoodArtifact();
    record(environmentConfig(artifact, "production").rpcPolicy).sequencerAcceptedMethods = [...methods];
    assertOnlyCheckFails(await validate(await createWorkspace(context, artifact)), "production-sequencer-policy");
  });
}

test("allows application-specific submission errors alongside required errors", async (context) => {
  const artifact = await knownGoodArtifact();
  const policy = record(environmentConfig(artifact, "production").rpcPolicy);
  policy.retryableSubmissionErrors = ["context deadline exceeded", "network unavailable"];
  policy.terminalSubmissionErrors = ["nonce too low", "execution reverted", "application rejected"];
  const result = await validate(await createWorkspace(context, artifact));

  assert.equal(result.score, 1);
  assert.equal(result.fullPass, true);
});

test("rejects a submission error classified as both retryable and terminal", async (context) => {
  const artifact = await knownGoodArtifact();
  const policy = record(environmentConfig(artifact, "production").rpcPolicy);
  // Contradictory: the required retryable error is also declared terminal.
  policy.terminalSubmissionErrors = ["nonce too low", "execution reverted", "context deadline exceeded"];

  assertOnlyCheckFails(await validate(await createWorkspace(context, artifact)), "production-sequencer-policy");
});

test("rejects a contradictory classification introduced by an application-specific error", async (context) => {
  const artifact = await knownGoodArtifact();
  const policy = record(environmentConfig(artifact, "staging").rpcPolicy);
  policy.retryableSubmissionErrors = ["context deadline exceeded", "upstream unavailable"];
  policy.terminalSubmissionErrors = ["nonce too low", "execution reverted", "upstream unavailable"];

  assertOnlyCheckFails(await validate(await createWorkspace(context, artifact)), "staging-sequencer-policy");
});

test("rejects reintroducing removed system-interface fields", async (context) => {
  const artifact = await knownGoodArtifact();
  record(environmentConfig(artifact, "production").contracts).arbSys = "0x0000000000000000000000000000000000000064";
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "json-shape", false);
  assertCheck(result, "preservation", true);
  assert.equal(result.fullPass, false);
});

test("matrix: wrong address in the correct structure fails only bridge-addresses", async (context) => {
  const artifact = await knownGoodArtifact();
  const contracts = record(
    record(record(environmentConfig(artifact, "production").assetOnboarding).canonicalBridge).contracts,
  );
  contracts.l1Outbox = ZERO_ADDRESS;
  const result = await validate(await createWorkspace(context, artifact));

  assert.equal(result.score, (CHECK_COUNT - 1) / CHECK_COUNT);
  assertCheck(result, "production-bridge-addresses", false);
  assertCheck(result, "production-bridge-onboarding", true);
  assertCheck(result, "json-shape", true);
});

test("matrix: correct addresses directly under canonicalBridge pass facts but fail shape", async (context) => {
  const artifact = await knownGoodArtifact();
  const production = environmentConfig(artifact, "production");
  const bridge = record(record(production.assetOnboarding).canonicalBridge);
  const contracts = record(bridge.contracts);
  Object.assign(bridge, {
    l1GatewayRouter: contracts.l1GatewayRouter,
    l2GatewayRouter: contracts.l2GatewayRouter,
    l1Erc20Gateway: contracts.l1Erc20Gateway,
    l1Outbox: contracts.l1Outbox,
  });
  delete bridge.contracts;
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "production-bridge-addresses", true);
  assertCheck(result, "production-bridge-onboarding", true);
  assertCheck(result, "json-shape", false);
  assert.equal(result.fullPass, false);
});

test("matrix: correct canonicalBridge.outbox alias passes facts but fails shape", async (context) => {
  const artifact = await knownGoodArtifact();
  const production = environmentConfig(artifact, "production");
  const bridge = record(record(production.assetOnboarding).canonicalBridge);
  const contracts = record(bridge.contracts);
  bridge.outbox = contracts.l1Outbox;
  delete contracts.l1Outbox;
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "production-bridge-addresses", true);
  assertCheck(result, "production-bridge-onboarding", true);
  assertCheck(result, "json-shape", false);
  assert.equal(result.fullPass, false);
});

test("accepts flat canonicalBridge.l1ERC20Gateway spelling for address facts but fails shape", async (context) => {
  const artifact = await knownGoodArtifact();
  const production = environmentConfig(artifact, "production");
  const bridge = record(record(production.assetOnboarding).canonicalBridge);
  const contracts = record(bridge.contracts);
  Object.assign(bridge, {
    l1GatewayRouter: contracts.l1GatewayRouter,
    l2GatewayRouter: contracts.l2GatewayRouter,
    l1ERC20Gateway: contracts.l1Erc20Gateway,
    l1Outbox: contracts.l1Outbox,
  });
  delete bridge.contracts;
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "production-bridge-addresses", true);
  assertCheck(result, "production-bridge-onboarding", true);
  assertCheck(result, "json-shape", false);
});

test("scores nested contracts.l1ERC20Gateway and contracts.outbox spellings but fails shape", async (context) => {
  const artifact = await knownGoodArtifact();
  const contracts = record(
    record(record(environmentConfig(artifact, "production").assetOnboarding).canonicalBridge).contracts,
  );
  contracts.l1ERC20Gateway = contracts.l1Erc20Gateway;
  delete contracts.l1Erc20Gateway;
  contracts.outbox = contracts.l1Outbox;
  delete contracts.l1Outbox;
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "production-bridge-addresses", true);
  assertCheck(result, "production-bridge-onboarding", true);
  assertCheck(result, "json-shape", false);
  assert.equal(result.score, (CHECK_COUNT - 1) / CHECK_COUNT);
});

for (const [canonical, legacy] of [
  ["l1GatewayRouter", "parentL1GatewayRouter"],
  ["l2GatewayRouter", "childL2GatewayRouter"],
  ["l1Erc20Gateway", "parentL1Erc20Gateway"],
  ["l1Outbox", "parentOutbox"],
] as const) {
  test(`accepts bridgeContracts.${legacy} as an address alias but not canonical shape`, async (context) => {
    const artifact = await knownGoodArtifact();
    const production = environmentConfig(artifact, "production");
    const bridge = record(record(production.assetOnboarding).canonicalBridge);
    const contracts = record(bridge.contracts);
    production.bridgeContracts = { [legacy]: contracts[canonical] };
    delete contracts[canonical];
    const result = await validate(await createWorkspace(context, artifact));

    assertCheck(result, "production-bridge-addresses", true);
    assertCheck(result, "production-bridge-onboarding", true);
    assertCheck(result, "json-shape", false);
  });
}

test("matrix: correct nested address plus conflicting wrong flat alias fails addresses and shape", async (context) => {
  const artifact = await knownGoodArtifact();
  const production = environmentConfig(artifact, "production");
  record(production.contracts).l1Outbox = ZERO_ADDRESS;
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "production-bridge-addresses", false);
  assertCheck(result, "production-bridge-onboarding", true);
  assertCheck(result, "json-shape", false);
  assert.equal(result.fullPass, false);
});

test("matrix: correct nested address plus identical redundant flat alias passes facts but fails shape", async (context) => {
  const artifact = await knownGoodArtifact();
  const production = environmentConfig(artifact, "production");
  const contracts = record(
    record(record(production.assetOnboarding).canonicalBridge).contracts,
  );
  record(production.contracts).l1Outbox = contracts.l1Outbox;
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "production-bridge-addresses", true);
  assertCheck(result, "production-bridge-onboarding", true);
  assertCheck(result, "json-shape", false);
  assert.equal(result.fullPass, false);
});

test("matrix: correct addresses but bridge disabled fails only onboarding", async (context) => {
  const artifact = await knownGoodArtifact();
  record(record(environmentConfig(artifact, "production").assetOnboarding).canonicalBridge).enabled =
    false;
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "production-bridge-addresses", true);
  assertCheck(result, "production-bridge-onboarding", false);
  assertCheck(result, "json-shape", true);
  assert.equal(result.score, (CHECK_COUNT - 1) / CHECK_COUNT);
});

test("accepts address casing and harmless URL trailing slashes", async (context) => {
  const artifact = await knownGoodArtifact();
  for (const environment of ENVIRONMENTS) {
    const config = environmentConfig(artifact, environment);
    const chain = record(config.chain);
    const rpcPolicy = record(config.rpcPolicy);
    for (const key of ["rpcUrl", "explorerUrl"] as const) {
      chain[key] = `${String(chain[key]).replace(/\/+$/, "")}/`;
    }
    for (const key of ["readRpcUrl", "writeRpcUrl", "sequencerSubmissionUrl"] as const) {
      rpcPolicy[key] = `${String(rpcPolicy[key]).replace(/\/+$/, "")}/`;
    }
    lowerCaseAddresses(record(config.tokens));
  }

  const result = await validate(await createWorkspace(context, artifact));
  assert.equal(result.score, 1);
  assert.equal(result.fullPass, true);
});

test("accepts bridge addresses in a legacy contracts subtree while failing shape", async (context) => {
  const artifact = await knownGoodArtifact();
  const production = environmentConfig(artifact, "production");
  const bridge = record(record(record(production.assetOnboarding).canonicalBridge).contracts);
  Object.assign(record(production.contracts), {
    l1GatewayRouter: bridge.l1GatewayRouter,
    l2GatewayRouter: bridge.l2GatewayRouter,
    l1ERC20Gateway: bridge.l1Erc20Gateway,
    outbox: bridge.l1Outbox,
  });
  delete record(record(production.assetOnboarding).canonicalBridge).contracts;
  record(production.assetOnboarding).preferredRoute = "canonical-bridge";
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "production-bridge-addresses", true);
  assertCheck(result, "production-bridge-onboarding", true);
  assertCheck(result, "json-shape", false);
  assert.equal(result.fullPass, false);
});

test("detects preserved Multicall3 and unrelated setting mutations", async (context) => {
  const artifact = await knownGoodArtifact();
  record(environmentConfig(artifact, "staging").contracts).multicall3 = ZERO_ADDRESS;
  record(record(artifact.application).features).swaps = true;
  const result = await validate(await createWorkspace(context, artifact));

  assert.equal(result.score, (CHECK_COUNT - 1) / CHECK_COUNT);
  assertCheck(result, "preservation", false);
});

for (const [group, field] of IMMUTABLE_PRESERVATION_CASES) {
  test(`preservation fails when immutable ${group}.${field} changes`, async (context) => {
    const artifact = await knownGoodArtifact();
    const target = record(artifact[group]);
    target[field] = incorrectValue(target[field]);
    const result = await validate(await createWorkspace(context, artifact));

    assertCheck(result, "preservation", false);
    assertCheck(result, "json-shape", true);
  });
}

for (const [group, field] of IMMUTABLE_ENVIRONMENT_PRESERVATION_CASES) {
  test(`preservation fails when immutable production.${group}.${field} changes`, async (context) => {
    const artifact = await knownGoodArtifact();
    const target = record(environmentConfig(artifact, "production")[group]);
    target[field] = incorrectValue(target[field]);
    const result = await validate(await createWorkspace(context, artifact));

    assertCheck(result, "preservation", false);
    assertCheck(result, "json-shape", true);
  });
}

test("preservation ignores output-only additions while shape owns them", async (context) => {
  const artifact = await knownGoodArtifact();
  record(artifact.application).inventedSetting = "should-fail-shape-not-preservation";
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "preservation", true);
  assertCheck(result, "json-shape", false);
});

test("missing container keys fail json-shape", async (context) => {
  const artifact = await knownGoodArtifact();
  delete record(environmentConfig(artifact, "staging")).finalityPolicy;
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "json-shape", false);
  assert.equal(result.fullPass, false);
});

test("authorized mutable changes do not affect preservation", async (context) => {
  const artifact = await knownGoodArtifact();
  for (const environment of ENVIRONMENTS) {
    const config = environmentConfig(artifact, environment);
    record(config.chain).name = `${String(record(config.chain).name)}-authorized`;
    record(config.rpcPolicy).readRpcUrl = "https://example.invalid/rpc";
    record(config.tokens).WETH = ZERO_ADDRESS;
    record(config.assetOnboarding).enabled = false;
  }
  const result = await validate(await createWorkspace(context, artifact));

  assertCheck(result, "preservation", true);
  assertCheck(result, "json-shape", true);
  assert.equal(result.fullPass, false);
});

test("detects a changed requested-file key topology outside the allowed bridge contracts addition", async (context) => {
  const artifact = await knownGoodArtifact();
  delete record(environmentConfig(artifact, "production").rpcPolicy).terminalSubmissionErrors;
  const result = await validate(await createWorkspace(context, artifact));

  assert.equal(result.score, (CHECK_COUNT - 2) / CHECK_COUNT);
  assertCheck(result, "preservation", true);
  assertCheck(result, "json-shape", false);
  assertCheck(result, "production-sequencer-policy", false);
});

test("grades missing requested output as zero", async (context) => {
  assertGradedZero(await validate(await createEmptyWorkspace(context)));
});

test("grades malformed JSON output as zero", async (context) => {
  const workspace = await createEmptyWorkspace(context);
  await writeFile(resolve(workspace, "config.json"), "{ not-json\n");
  assertGradedZero(await validate(workspace));
});

test("grades a structurally unusable artifact as zero", async (context) => {
  assertGradedZero(await validate(await createWorkspace(context, [])));
});

test("reports an internal fixture failure as infrastructure error", async (context) => {
  const result = await validate(await createWorkspace(context, await knownGoodArtifact()), {
    fixturePath: resolve("/missing", "fixture.json"),
  });
  assertInfrastructureError(result);
});

test("reports malformed or incompletely sourced oracle data as infrastructure", async (context) => {
  const workspace = await createWorkspace(context, await knownGoodArtifact());
  const oracle = await readJson(ORACLE_PATH);
  const sources = oracle.sources as unknown[];
  sources.pop();
  const oraclePath = resolve(workspace, "incomplete-oracle.json");
  await writeFile(oraclePath, `${JSON.stringify(oracle, null, 2)}\n`);

  assertInfrastructureError(await validate(workspace, { oraclePath }));
});

for (const candidate of ["missing", "malformed", "valid"] as const) {
  for (const brokenInput of ["missing fixture", "malformed fixture", "invalid fixture shape", "invalid oracle", "incomplete oracle sources"] as const) {
    test(`reports ${brokenInput} as infrastructure with ${candidate} candidate output`, async () => {
      const fixtureText = await readFile(FIXTURE_PATH, "utf8");
      const fixtureFiles: Record<string, string> = { "config.json": Buffer.from(fixtureText).toString("base64") };
      let oracle: unknown = await readJson(ORACLE_PATH);
      if (brokenInput === "missing fixture") delete fixtureFiles["config.json"];
      if (brokenInput === "malformed fixture") fixtureFiles["config.json"] = Buffer.from("{ broken json").toString("base64");
      if (brokenInput === "invalid fixture shape") fixtureFiles["config.json"] = Buffer.from("{}").toString("base64");
      if (brokenInput === "invalid oracle") oracle = {};
      if (brokenInput === "incomplete oracle sources") record(oracle).sources = [];
      const candidateFiles: Record<string, string> = {};
      if (candidate !== "missing") {
        candidateFiles["config.json"] = Buffer.from(candidate === "malformed" ? "{ broken json" : fixtureText).toString("base64");
      }

      const result = validateSnapshot({ outputPath: "config.json", fixtureFiles, candidateFiles, oracle });
      assertInfrastructureError(result);
      assert.equal(result.checks.length, 1);
      assert.equal(result.checks[0]?.id, "validator-infrastructure");
    });
  }
}

test("honors loader-provided fixture root and requested output path", async (context) => {
  const workspace = await createEmptyWorkspace(context);
  const fixtureRoot = await createEmptyWorkspace(context);
  const outputPath = "nested/config.json";
  await Promise.all([
    mkdir(resolve(workspace, "nested"), { recursive: true }),
    mkdir(resolve(fixtureRoot, "nested"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(workspace, outputPath), `${JSON.stringify(await knownGoodArtifact(), null, 2)}\n`),
    copyFile(FIXTURE_PATH, resolve(fixtureRoot, outputPath)),
  ]);

  const result = await validateWorkspace({
    workspaceRoot: workspace,
    fixtureRoot,
    oraclePath: ORACLE_PATH,
    outputPath,
  });
  assert.equal(result.score, 1);
  assert.equal(result.fullPass, true);
});

async function knownGoodArtifact(): Promise<JsonObject> {
  const fixture = await readJson(FIXTURE_PATH);
  const oracle = await readJson(ORACLE_PATH);
  const expected = record(oracle.expected);
  for (const environment of ENVIRONMENTS) {
    const target = environmentConfig(fixture, environment);
    const expectedEnvironment = record(expected[environment]);
    Object.assign(record(target.chain), record(expectedEnvironment.chain));
    Object.assign(record(target.rpcPolicy), record(expectedEnvironment.rpcPolicy));
    Object.assign(record(target.tokens), record(expectedEnvironment.tokens));
    const targetOnboarding = record(target.assetOnboarding);
    const expectedOnboarding = record(expectedEnvironment.assetOnboarding);
    Object.assign(targetOnboarding, expectedOnboarding);
    const targetBridge = record(targetOnboarding.canonicalBridge);
    const expectedBridge = record(expectedOnboarding.canonicalBridge);
    Object.assign(targetBridge, expectedBridge);
    Object.assign(record(targetBridge.contracts), record(expectedBridge.contracts));
    Object.assign(record(target.finalityPolicy), record(expectedEnvironment.finalityPolicy));
  }
  return fixture;
}

function environmentConfig(root: JsonObject, environment: (typeof ENVIRONMENTS)[number]): JsonObject {
  return record(record(record(root.networkConfig).environments)[environment]);
}

function incorrectValue(value: unknown): unknown {
  if (value === null) return ZERO_ADDRESS;
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value + 1;
  if (Array.isArray(value)) return value.map((entry) => `${String(entry)}-wrong`);
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return ZERO_ADDRESS;
  if (typeof value === "string") return `${value}-wrong`;
  throw new Error(`No mutation strategy for ${String(value)}`);
}

function lowerCaseAddresses(value: JsonObject): void {
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "multicall3" && typeof entry === "string" && /^0x[0-9a-fA-F]{40}$/.test(entry)) {
      value[key] = entry.toLowerCase();
    }
  }
}

async function readJson(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

async function createWorkspace(context: test.TestContext, artifact: unknown): Promise<string> {
  const workspace = await createEmptyWorkspace(context);
  await writeFile(resolve(workspace, "config.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  return workspace;
}

async function createEmptyWorkspace(context: test.TestContext): Promise<string> {
  const workspace = await mkdtemp(resolve(tmpdir(), "network-config-01-validator-test-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(workspace, { recursive: true });
  return workspace;
}

function record(value: unknown): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function assertCheck(result: ValidationOutcome, id: string, passed: boolean): void {
  assert.equal(result.checks.find((check) => check.id === id)?.passed, passed);
}

function assertOnlyCheckFails(result: ValidationOutcome, id: string): void {
  assert.equal(result.status, "graded");
  assert.equal(result.score, (CHECK_COUNT - 1) / CHECK_COUNT);
  assert.equal(result.fullPass, false);
  assertCheck(result, id, false);
  assertCheck(result, "json-shape", true);
  assertCheck(result, "preservation", true);
}

function assertGradedZero(result: ValidationOutcome): void {
  assert.equal(result.status, "graded");
  assert.equal(result.score, 0);
  assert.equal(result.fullPass, false);
  assert.equal(result.checks.length, CHECK_COUNT);
  assert.ok(result.checks.every((check) => !check.passed));
}

function assertInfrastructureError(result: ValidationOutcome): void {
  assert.equal(result.status, "infrastructure-failure");
  assert.equal(result.score, null);
  assert.equal(result.fullPass, null);
  assert.equal(result.checks[0]?.id, "validator-infrastructure");
}

const OTHER_ENVIRONMENT = { production: "staging", staging: "production" } as const;

async function rpcArtifact(
  mutate: (rpcPolicy: Record<(typeof ENVIRONMENTS)[number], JsonObject>, expected: Record<(typeof ENVIRONMENTS)[number], JsonObject>) => void,
): Promise<JsonObject> {
  const artifact = await knownGoodArtifact();
  const expected = record((await readJson(ORACLE_PATH)).expected);
  mutate(
    {
      production: record(environmentConfig(artifact, "production").rpcPolicy),
      staging: record(environmentConfig(artifact, "staging").rpcPolicy),
    },
    { production: record(record(expected.production).rpcPolicy), staging: record(record(expected.staging).rpcPolicy) },
  );
  return artifact;
}

async function rpcTopicPoints(result: ValidationOutcome): Promise<number> {
  const rubric = JSON.parse(await readFile(RUBRIC_PATH, "utf8")) as {
    checks: Array<{ id: string; topic?: string; points: number }>;
  };
  return rubric.checks
    .filter((check) => check.topic === "rpc-endpoints")
    .filter((check) => result.checks.find((c) => c.id === check.id)?.passed === true)
    .reduce((sum, check) => sum + check.points, 0);
}

test("rubric RPC topic holds exactly rpc-routing and write-rpc-provider at 5 points each", async () => {
  const rubric = JSON.parse(await readFile(RUBRIC_PATH, "utf8")) as {
    checks: Array<{ id: string; group: string; topic?: string; points: number }>;
  };
  assert.deepEqual(
    rubric.checks.filter((check) => check.topic === "rpc-endpoints").map((check) => [check.id, check.group, check.points]),
    [["rpc-routing", "outcome", 5], ["write-rpc-provider", "outcome", 5]],
  );
});

test("general public RPC writes with correct routing earn the full RPC topic", async (context) => {
  const result = await validate(await createWorkspace(context, await knownGoodArtifact()));
  assertCheck(result, "rpc-routing", true);
  assertCheck(result, "write-rpc-provider", true);
  assert.equal(await rpcTopicPoints(result), 10);
});

test("each network's own sequencer as writeRpcUrl in both environments passes routing only", async (context) => {
  const artifact = await rpcArtifact((policy, expected) => {
    for (const environment of ENVIRONMENTS) policy[environment].writeRpcUrl = expected[environment].sequencerSubmissionUrl;
  });
  const result = await validate(await createWorkspace(context, artifact));
  assertCheck(result, "rpc-routing", true);
  assertCheck(result, "write-rpc-provider", false);
  assert.equal(await rpcTopicPoints(result), 5);
  assert.equal(result.score, (CHECK_COUNT - 1) / CHECK_COUNT);
  assert.match(result.checks.find((check) => check.id === "write-rpc-provider")?.message ?? "", /production, staging/);
});

for (const environment of ENVIRONMENTS) {
  test(`own sequencer as ${environment} writeRpcUrl only passes routing and fails the provider check`, async (context) => {
    const artifact = await rpcArtifact((policy, expected) => {
      policy[environment].writeRpcUrl = expected[environment].sequencerSubmissionUrl;
    });
    const result = await validate(await createWorkspace(context, artifact));
    assertCheck(result, "rpc-routing", true);
    assertCheck(result, "write-rpc-provider", false);
    assert.equal(await rpcTopicPoints(result), 5);
    assert.match(result.checks.find((check) => check.id === "write-rpc-provider")?.message ?? "", new RegExp(`: ${environment}\\.$`));
  });

  test(`wrong ${environment} sequencerSubmissionUrl fails routing while public RPC writes pass the provider check`, async (context) => {
    const artifact = await rpcArtifact((policy) => {
      policy[environment].sequencerSubmissionUrl = "https://example.invalid/sequencer";
    });
    const result = await validate(await createWorkspace(context, artifact));
    assertCheck(result, "rpc-routing", false);
    assertCheck(result, "write-rpc-provider", true);
    assert.equal(await rpcTopicPoints(result), 5);
    assert.match(result.checks.find((check) => check.id === "rpc-routing")?.message ?? "", new RegExp(`: ${environment}\\.`));
  });

  test(`the other network's sequencer as ${environment} writeRpcUrl fails routing`, async (context) => {
    const artifact = await rpcArtifact((policy, expected) => {
      policy[environment].writeRpcUrl = expected[OTHER_ENVIRONMENT[environment]].sequencerSubmissionUrl;
    });
    const result = await validate(await createWorkspace(context, artifact));
    assertCheck(result, "rpc-routing", false);
    assertCheck(result, "write-rpc-provider", false);
    assert.equal(await rpcTopicPoints(result), 0);
  });

  test(`an unrelated ${environment} writeRpcUrl fails routing`, async (context) => {
    const artifact = await rpcArtifact((policy) => {
      policy[environment].writeRpcUrl = "https://example.invalid/rpc";
    });
    const result = await validate(await createWorkspace(context, artifact));
    assertCheck(result, "rpc-routing", false);
    assertCheck(result, "write-rpc-provider", false);
  });

  test(`wrong ${environment} readRpcUrl fails routing and leaves the provider check unaffected`, async (context) => {
    const artifact = await rpcArtifact((policy) => {
      policy[environment].readRpcUrl = "https://example.invalid/rpc";
    });
    const result = await validate(await createWorkspace(context, artifact));
    assertCheck(result, "rpc-routing", false);
    assertCheck(result, "write-rpc-provider", true);
    assert.equal(await rpcTopicPoints(result), 5);
  });
}

test("RPC changes never affect the other topics, including both bridge checks per environment", async (context) => {
  const artifact = await rpcArtifact((policy, expected) => {
    for (const environment of ENVIRONMENTS) policy[environment].writeRpcUrl = expected[environment].sequencerSubmissionUrl;
  });
  const result = await validate(await createWorkspace(context, artifact));
  const rubric = JSON.parse(await readFile(RUBRIC_PATH, "utf8")) as {
    checks: Array<{ id: string; topic?: string; points: number }>;
  };
  for (const topic of ["bridge-addresses", "bridge-onboarding"]) {
    const bridge = rubric.checks.filter((check) => check.topic === topic);
    assert.deepEqual(bridge.map((check) => check.id), [`production-${topic}`, `staging-${topic}`]);
    assert.equal(bridge.reduce((sum, check) => sum + check.points, 0), 10);
  }
  assert.equal(
    rubric.checks.filter((check) => check.topic?.startsWith("bridge-")).reduce((sum, check) => sum + check.points, 0),
    20,
  );
  for (const check of result.checks) {
    if (check.id !== "write-rpc-provider") assert.equal(check.passed, true, check.id);
  }
});
