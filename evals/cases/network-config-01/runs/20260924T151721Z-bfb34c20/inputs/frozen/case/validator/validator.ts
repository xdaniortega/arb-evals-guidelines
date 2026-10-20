import { isDeepStrictEqual } from "node:util";
const ENVIRONMENTS = ["production", "staging"] as const;
const GLOBAL_CHECK_IDS = ["json-shape", "preservation"] as const;
const ENVIRONMENT_CHECK_NAMES = [
  "chain-identity",
  "legacy-fallback",
  "rpc-endpoints",
  "sequencer-policy",
  "token-identity",
  "bridge-addresses",
  "bridge-onboarding",
  "finality-policy",
] as const;
const CHECK_IDS = [
  ...GLOBAL_CHECK_IDS,
  ...ENVIRONMENTS.flatMap((environment) =>
    ENVIRONMENT_CHECK_NAMES.map((check) => `${environment}-${check}` as const)
  ),
] as const;
const CHAIN_KEYS = ["name", "chainId", "rpcUrl", "explorerUrl", "deprecatedGoerliFallbackUrl"] as const;
const RPC_ENDPOINT_KEYS = ["readRpcUrl", "writeRpcUrl", "sequencerSubmissionUrl"] as const;
const RPC_POLICY_KEYS = [
  ...RPC_ENDPOINT_KEYS,
  "sequencerSubmissionOnly",
  "sequencerAcceptedMethods",
  "retryableSubmissionErrors",
  "terminalSubmissionErrors",
] as const;
const TOKEN_KEYS = ["WETH", "USDC", "USDC.e"] as const;
const FINALITY_POLICY_KEYS = ["withdrawalsToEthereumAreInstant", "challengeWindowBlocks", "forceIncludePeriodBlocks"] as const;
const BRIDGE_CONTRACT_KEYS = ["l1GatewayRouter", "l2GatewayRouter", "l1Erc20Gateway", "l1Outbox"] as const;
const BRIDGE_ADDRESS_ALIASES: Record<(typeof BRIDGE_CONTRACT_KEYS)[number], readonly (readonly string[])[]> = {
  l1GatewayRouter: [
    ["assetOnboarding", "canonicalBridge", "contracts", "l1GatewayRouter"],
    ["assetOnboarding", "canonicalBridge", "l1GatewayRouter"],
    ["contracts", "l1GatewayRouter"],
    ["bridgeContracts", "parentL1GatewayRouter"],
  ],
  l2GatewayRouter: [
    ["assetOnboarding", "canonicalBridge", "contracts", "l2GatewayRouter"],
    ["assetOnboarding", "canonicalBridge", "l2GatewayRouter"],
    ["contracts", "l2GatewayRouter"],
    ["bridgeContracts", "childL2GatewayRouter"],
  ],
  l1Erc20Gateway: [
    ["assetOnboarding", "canonicalBridge", "contracts", "l1Erc20Gateway"],
    ["assetOnboarding", "canonicalBridge", "contracts", "l1ERC20Gateway"],
    ["assetOnboarding", "canonicalBridge", "l1Erc20Gateway"],
    ["assetOnboarding", "canonicalBridge", "l1ERC20Gateway"],
    ["contracts", "l1Erc20Gateway"],
    ["contracts", "l1ERC20Gateway"],
    ["bridgeContracts", "parentL1Erc20Gateway"],
  ],
  l1Outbox: [
    ["assetOnboarding", "canonicalBridge", "contracts", "l1Outbox"],
    ["assetOnboarding", "canonicalBridge", "contracts", "outbox"],
    ["assetOnboarding", "canonicalBridge", "l1Outbox"],
    ["assetOnboarding", "canonicalBridge", "outbox"],
    ["contracts", "l1Outbox"],
    ["contracts", "outbox"],
    ["bridgeContracts", "parentOutbox"],
  ],
};
const ORACLE_SOURCE_FIELDS = [
  "chainIdentity",
  "rpcPolicy",
  "legacyNetworkFallback",
  "sequencerPolicy",
  "finalityPolicy",
  "wrappedNativeTokens",
  "bridgeOnboarding",
  "nativeUsdcTokens",
  "bridgedUsdcEToken",
] as const;
const ALLOWED_ADDED_PATHS = ENVIRONMENTS.map((environment) => [
  "networkConfig",
  "environments",
  environment,
  "assetOnboarding",
  "canonicalBridge",
  "contracts",
]);
const ALLOWED_REMOVED_PATHS = ENVIRONMENTS.map((environment) => [
  "networkConfig",
  "environments",
  environment,
  "chain",
  "deprecatedGoerliFallbackUrl",
]);
const MUTABLE_PATHS = ENVIRONMENTS.flatMap((environment) => [
  ...CHAIN_KEYS.map((field) => ["networkConfig", "environments", environment, "chain", field]),
  ...RPC_POLICY_KEYS.map((field) => ["networkConfig", "environments", environment, "rpcPolicy", field]),
  ...TOKEN_KEYS.map((field) => ["networkConfig", "environments", environment, "tokens", field]),
  ...FINALITY_POLICY_KEYS.map((field) => ["networkConfig", "environments", environment, "finalityPolicy", field]),
  ["networkConfig", "environments", environment, "assetOnboarding", "enabled"],
  ["networkConfig", "environments", environment, "assetOnboarding", "preferredRoute"],
  ["networkConfig", "environments", environment, "assetOnboarding", "canonicalBridge", "enabled"],
  ["networkConfig", "environments", environment, "assetOnboarding", "canonicalBridge", "contracts"],
]);

type EnvironmentName = (typeof ENVIRONMENTS)[number];
type CheckId = (typeof CHECK_IDS)[number];
type SourceField = (typeof ORACLE_SOURCE_FIELDS)[number];

type EnvironmentCheckName = (typeof ENVIRONMENT_CHECK_NAMES)[number];

export type ValidationOutcome = {
  status: "graded" | "infrastructure-failure";
  score: number | null;
  fullPass: boolean | null;
  checks: Array<{ id: string; passed: boolean; message: string }>;
};

export interface SnapshotValidationInput {
  readonly outputPath: string;
  readonly fixtureFiles: Readonly<Record<string, string>>;
  readonly candidateFiles: Readonly<Record<string, string>>;
  readonly oracle: unknown;
}

/**
 * @notice Grades candidate agent workspace outputs against recorded oracle data and initial fixtures without relying on agent self-reports.
 * @param input Validation inputs containing candidate workspace files, baseline fixtures, output path, and oracle data.
 * @returns Graded validation outcome including numeric score, check evaluations, and overall pass status.
 * @dev Validates trusted inputs before scoring any candidate; missing or invalid output scores zero only when the fixture and oracle are valid.
 */
export function validateSnapshot(input: SnapshotValidationInput): ValidationOutcome {
  try {
    const fixtureText = decodeSnapshotFile(input.fixtureFiles[input.outputPath]);
    if (fixtureText === null) return infrastructureError(new Error(`Fixture is missing ${input.outputPath}`));
    const fixture = parseFixture(JSON.parse(fixtureText) as unknown);
    const oracle = parseOracle(input.oracle);
    const outputText = decodeSnapshotFile(input.candidateFiles[input.outputPath]);
    if (outputText === null) return gradedZero(`Requested output ${input.outputPath} is missing or is not a regular file.`);
    let output: unknown;
    try {
      output = JSON.parse(outputText) as unknown;
    } catch {
      return gradedZero(`Requested output ${input.outputPath} is not valid JSON.`);
    }
    return gradeParsed(output, fixture, oracle);
  } catch (error) {
    return infrastructureError(error);
  }
}

interface TargetEnvironment {
  chain: {
    name: string;
    chainId: number;
    rpcUrl: string;
    explorerUrl: string;
    deprecatedGoerliFallbackUrl: null;
  };
  rpcPolicy: {
    readRpcUrl: string;
    writeRpcUrl: string;
    sequencerSubmissionUrl: string;
    sequencerSubmissionOnly: true;
    sequencerAcceptedMethods: readonly string[];
    retryableSubmissionErrors: readonly string[];
    terminalSubmissionErrors: readonly string[];
  };
  tokens: {
    WETH: string;
    USDC: string;
    "USDC.e": string | null;
  };
  assetOnboarding: {
    enabled: boolean;
    preferredRoute: string;
    canonicalBridge: {
      enabled: boolean;
      contracts: Record<(typeof BRIDGE_CONTRACT_KEYS)[number], string>;
    };
  };
  finalityPolicy: {
    withdrawalsToEthereumAreInstant: false;
    challengeWindowBlocks: number;
    forceIncludePeriodBlocks: number;
  };
}

interface Oracle {
  expected: Record<EnvironmentName, TargetEnvironment>;
  sources: Array<{ fields: SourceField[]; url: string; locator: string; verifiedAt: string }>;
}

interface ValidationCheck {
  id: CheckId;
  passed: boolean;
  message: string;
}

function gradeParsed(output: unknown, fixture: unknown, oracle: Oracle): ValidationOutcome {
  const checks: ValidationCheck[] = [
    buildCheck(
      "json-shape",
      outputPreservesShape(output, fixture),
      "The output preserves the fixture shape, except for a canonicalBridge.contracts subtree using canonical bridge contract key names.",
      "The output changed the fixture key topology outside a canonicalBridge.contracts subtree using canonical bridge contract key names.",
    ),
    buildCheck(
      "preservation",
      fixtureValuesPreserved(output, fixture),
      "Unrelated application settings and existing Multicall3 values are unchanged.",
      "An unrelated application setting, existing Multicall3 value, or other preserved field changed.",
    ),
  ];

  for (const environment of ENVIRONMENTS) {
    const actual = getEnvironment(output, environment);
    const expected = oracle.expected[environment];
    checks.push(
      environmentCheck(environment, "chain-identity", chainMatches(actual, expected)),
      environmentCheck(environment, "legacy-fallback", legacyFallbackMatches(actual, expected)),
      environmentCheck(environment, "rpc-endpoints", rpcEndpointsMatch(actual, expected)),
      environmentCheck(environment, "sequencer-policy", sequencerPolicyMatches(actual, expected)),
      environmentCheck(environment, "token-identity", tokensMatch(actual, expected)),
      environmentCheck(environment, "bridge-addresses", bridgeAddressesMatch(actual, expected)),
      environmentCheck(environment, "bridge-onboarding", bridgeOnboardingMatches(actual, expected)),
      environmentCheck(environment, "finality-policy", finalityPolicyMatches(actual, expected)),
    );
  }

  const score = checks.filter((check) => check.passed).length / checks.length;
  return { status: "graded", score, fullPass: score === 1, checks };
}

function decodeSnapshotFile(value: string | undefined): string | null {
  if (value === undefined) return null;
  return Buffer.from(value, "base64").toString("utf8");
}

function buildCheck(id: CheckId, passed: boolean, passMessage: string, failMessage: string): ValidationCheck {
  return { id, passed, message: passed ? passMessage : failMessage };
}

function environmentCheck(environment: EnvironmentName, name: EnvironmentCheckName, passed: boolean): ValidationCheck {
  const id = `${environment}-${name}` as CheckId;
  const messages = checkMessages(name, environment);
  return { id, passed, message: passed ? messages.pass : messages.fail };
}

function checkMessages(name: EnvironmentCheckName, environment: EnvironmentName): { pass: string; fail: string } {
  const label = environment === "production" ? "Production" : "Staging";
  switch (name) {
    case "chain-identity":
      return {
        pass: `${label} chain identity, public RPC, and explorer are correct.`,
        fail: `${label} chain identity, public RPC, or explorer is incorrect.`,
      };
    case "legacy-fallback":
      return {
        pass: `${label} clears or removes the deprecated Goerli fallback.`,
        fail: `${label} retains, relocates, or replaces the deprecated Goerli fallback.`,
      };
    case "rpc-endpoints":
      return {
        pass: `${label} read/write RPCs and sequencer routing endpoint are correct.`,
        fail: `${label} read/write RPC or sequencer routing endpoint is incorrect.`,
      };
    case "sequencer-policy":
      return {
        pass: `${label} sequencer submission policy and retry classification are correct.`,
        fail: `${label} sequencer-only behavior, methods, or error classification is incorrect.`,
      };
    case "token-identity":
      return {
        pass: `${label} WETH, USDC, and USDC.e token identities are correct.`,
        fail: `${label} WETH, USDC, or USDC.e value is wrong or invented.`,
      };
    case "bridge-addresses":
      return {
        pass: `${label} canonical bridge contract addresses are correct.`,
        fail: `${label} canonical bridge contract addresses are missing, wrong, incomplete, or conflict across aliases.`,
      };
    case "bridge-onboarding":
      return {
        pass: `${label} canonical bridge onboarding enabled state and preferred route are correct.`,
        fail: `${label} canonical bridge onboarding enabled state or preferred route is incorrect.`,
      };
    case "finality-policy":
      return {
        pass: `${label} withdrawal finality and force-inclusion policy are correct.`,
        fail: `${label} withdrawal finality, challenge window, or force-inclusion period is incorrect.`,
      };
  }
}

function chainMatches(actualEnvironment: Record<string, unknown> | null, expectedEnvironment: TargetEnvironment): boolean {
  const actual = childRecord(actualEnvironment, "chain");
  const expected = expectedEnvironment.chain;
  return actual?.name === expected.name &&
    actual.chainId === expected.chainId &&
    sameUrl(actual.rpcUrl, expected.rpcUrl) &&
    sameUrl(actual.explorerUrl, expected.explorerUrl);
}

function rpcEndpointsMatch(actualEnvironment: Record<string, unknown> | null, expectedEnvironment: TargetEnvironment): boolean {
  const actual = childRecord(actualEnvironment, "rpcPolicy");
  const expected = expectedEnvironment.rpcPolicy;
  return sameUrl(actual?.readRpcUrl, expected.readRpcUrl) &&
    sameUrl(actual?.writeRpcUrl, expected.writeRpcUrl) &&
    sameUrl(actual?.sequencerSubmissionUrl, expected.sequencerSubmissionUrl);
}

/**
 * A retired fallback may be cleared to null or removed outright. Keeping the value under
 * any other chain field is a relocation rather than a retirement and still fails.
 */
function legacyFallbackMatches(actualEnvironment: Record<string, unknown> | null, expectedEnvironment: TargetEnvironment): boolean {
  const chain = childRecord(actualEnvironment, "chain");
  if (chain === null) return false;
  const fallback = chain.deprecatedGoerliFallbackUrl;
  if (fallback !== undefined && fallback !== expectedEnvironment.chain.deprecatedGoerliFallbackUrl) return false;
  return !Object.values(chain).some(isRetiredNetworkReference);
}

function isRetiredNetworkReference(value: unknown): boolean {
  return typeof value === "string" && /goerli/i.test(value);
}

function sequencerPolicyMatches(actualEnvironment: Record<string, unknown> | null, expectedEnvironment: TargetEnvironment): boolean {
  const actual = childRecord(actualEnvironment, "rpcPolicy");
  const expected = expectedEnvironment.rpcPolicy;
  return actual?.sequencerSubmissionOnly === expected.sequencerSubmissionOnly &&
    sameStringSet(actual?.sequencerAcceptedMethods, expected.sequencerAcceptedMethods) &&
    includesStrings(actual?.retryableSubmissionErrors, expected.retryableSubmissionErrors) &&
    includesStrings(actual?.terminalSubmissionErrors, expected.terminalSubmissionErrors) &&
    // A submission error classified as BOTH retryable and terminal is a contradictory
    // policy: it tells the caller to retry and to give up on the same condition.
    // Additional application-specific errors stay allowed on either side.
    disjointStringSets(actual?.retryableSubmissionErrors, actual?.terminalSubmissionErrors);
}

function disjointStringSets(left: unknown, right: unknown): boolean {
  if (!isStringArray(left) || !isStringArray(right)) return false;
  const terminal = new Set(right);
  return !left.some((value) => terminal.has(value));
}

function tokensMatch(actualEnvironment: Record<string, unknown> | null, expectedEnvironment: TargetEnvironment): boolean {
  const actual = childRecord(actualEnvironment, "tokens");
  const expected = expectedEnvironment.tokens;
  return sameAddress(actual?.WETH, expected.WETH) &&
    sameAddress(actual?.USDC, expected.USDC) &&
    sameNullableAddress(actual?.["USDC.e"], expected["USDC.e"]);
}

function bridgeAddressesMatch(actualEnvironment: Record<string, unknown> | null, expectedEnvironment: TargetEnvironment): boolean {
  return BRIDGE_CONTRACT_KEYS.every((key) => {
    const aliases = collectBridgeAddressAliases(actualEnvironment, key);
    if (aliases.length === 0) return false;
    const expected = expectedEnvironment.assetOnboarding.canonicalBridge.contracts[key];
    return aliases.every((alias) => sameAddress(alias, expected));
  });
}

function bridgeOnboardingMatches(
  actualEnvironment: Record<string, unknown> | null,
  expectedEnvironment: TargetEnvironment,
): boolean {
  const actual = childRecord(actualEnvironment, "assetOnboarding");
  const bridge = childRecord(actual, "canonicalBridge");
  return actual !== null &&
    actual.enabled === expectedEnvironment.assetOnboarding.enabled &&
    isCanonicalBridgeRoute(actual.preferredRoute) &&
    bridge?.enabled === expectedEnvironment.assetOnboarding.canonicalBridge.enabled;
}

function finalityPolicyMatches(actualEnvironment: Record<string, unknown> | null, expectedEnvironment: TargetEnvironment): boolean {
  const actual = childRecord(actualEnvironment, "finalityPolicy");
  const expected = expectedEnvironment.finalityPolicy;
  return actual?.withdrawalsToEthereumAreInstant === expected.withdrawalsToEthereumAreInstant &&
    actual.challengeWindowBlocks === expected.challengeWindowBlocks &&
    actual.forceIncludePeriodBlocks === expected.forceIncludePeriodBlocks;
}

function collectBridgeAddressAliases(
  actualEnvironment: Record<string, unknown> | null,
  key: (typeof BRIDGE_CONTRACT_KEYS)[number],
): unknown[] {
  const aliases: unknown[] = [];
  for (const path of BRIDGE_ADDRESS_ALIASES[key]) {
    const value = valueAtPath(actualEnvironment, path);
    if (value !== undefined && value !== null) aliases.push(value);
  }
  return aliases;
}

function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isCanonicalBridgeRoute(value: unknown): boolean {
  return value === "canonicalBridge" || value === "canonical-bridge";
}

function sameStringSet(actual: unknown, expected: readonly string[]): boolean {
  if (!isStringArray(actual) || actual.length !== expected.length) return false;
  return new Set(actual).size === actual.length && actual.every((value) => expected.includes(value));
}

function includesStrings(actual: unknown, expected: readonly string[]): boolean {
  return isStringArray(actual) && expected.every((value) => actual.includes(value));
}

function outputPreservesShape(output: unknown, fixture: unknown): boolean {
  return isDeepStrictEqual(jsonKeyShape(normalizeShapeSource(output)), jsonKeyShape(normalizeShapeSource(fixture)));
}

/**
 * Exempt the approved contracts subtree from the topology comparison only when every
 * key in it is a canonical bridge contract name. An alias spelling still scores as an
 * address fact, but it is left in place here so it fails the shape check. The retired
 * fallback key is dropped from both sides so clearing it and removing it compare equal;
 * every other key removal still changes the topology.
 */
function normalizeShapeSource(value: unknown): unknown {
  const copy = structuredClone(value);
  for (const path of ALLOWED_ADDED_PATHS) {
    if (hasOnlyCanonicalBridgeKeys(valueAtPath(copy, path))) deletePath(copy, path);
  }
  for (const path of ALLOWED_REMOVED_PATHS) deletePath(copy, path);
  return copy;
}

function hasOnlyCanonicalBridgeKeys(subtree: unknown): boolean {
  if (subtree === undefined) return true;
  if (!isRecord(subtree)) return false;
  return Object.keys(subtree).every((key) =>
    (BRIDGE_CONTRACT_KEYS as readonly string[]).includes(key)
  );
}

/** Compare every fixture value exactly, skipping only prompt-authorized mutable paths. */
function fixtureValuesPreserved(output: unknown, fixture: unknown, path: readonly string[] = []): boolean {
  if (isMutablePath(path)) return true;
  if (Array.isArray(fixture) || !isRecord(fixture)) {
    return isDeepStrictEqual(output, fixture);
  }
  if (!isRecord(output)) return false;
  for (const key of Object.keys(fixture)) {
    if (!fixtureValuesPreserved(output[key], fixture[key], [...path, key])) return false;
  }
  return true;
}

function isMutablePath(path: readonly string[]): boolean {
  return MUTABLE_PATHS.some((mutable) =>
    mutable.length <= path.length && mutable.every((part, index) => part === path[index])
  );
}

function getEnvironment(value: unknown, environment: EnvironmentName): Record<string, unknown> | null {
  const root = isRecord(value) ? value : null;
  const networkConfig = childRecord(root, "networkConfig");
  const environments = childRecord(networkConfig, "environments");
  return childRecord(environments, environment);
}

function childRecord(parent: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return parent && isRecord(parent[key]) ? parent[key] : null;
}

function deletePath(value: unknown, path: readonly string[]): void {
  let current: unknown = value;
  for (const key of path.slice(0, -1)) {
    if (!isRecord(current)) return;
    current = current[key];
  }
  if (isRecord(current)) delete current[path.at(-1)!];
}

function jsonKeyShape(value: unknown): unknown {
  if (Array.isArray(value)) return { type: "array" };
  if (isRecord(value)) {
    return {
      type: "object",
      entries: Object.keys(value).sort().map((key) => [key, jsonKeyShape(value[key])]),
    };
  }
  return "value";
}

function parseFixture(value: unknown): unknown {
  const root = requireRecord(value, "fixture root");
  const networkConfig = requireRecord(root.networkConfig, "fixture networkConfig");
  const environments = requireExactRecord(networkConfig.environments, [...ENVIRONMENTS], "fixture environments");
  for (const environment of ENVIRONMENTS) {
    const record = requireRecord(environments[environment], `fixture ${environment}`);
    requireRecord(record.chain, `fixture ${environment}.chain`);
    requireRecord(record.rpcPolicy, `fixture ${environment}.rpcPolicy`);
    requireRecord(record.contracts, `fixture ${environment}.contracts`);
    requireRecord(record.tokens, `fixture ${environment}.tokens`);
    requireRecord(record.assetOnboarding, `fixture ${environment}.assetOnboarding`);
    requireRecord(record.finalityPolicy, `fixture ${environment}.finalityPolicy`);
  }
  return value;
}

function parseOracle(value: unknown): Oracle {
  const root = requireExactRecord(value, ["expected", "sources"], "oracle");
  const expectedRecord = requireExactRecord(root.expected, [...ENVIRONMENTS], "oracle expected");
  const expected = Object.fromEntries(
    ENVIRONMENTS.map((environment) => [environment, parseExpectedEnvironment(expectedRecord[environment], environment)]),
  ) as Record<EnvironmentName, TargetEnvironment>;

  if (!Array.isArray(root.sources) || root.sources.length === 0) throw new Error("oracle sources must contain at least one source");
  const coveredFields = new Set<SourceField>();
  const sources = root.sources.map((source, index) => {
    const record = requireExactRecord(source, ["fields", "url", "locator", "verifiedAt"], `oracle source ${index}`);
    if (!Array.isArray(record.fields) || record.fields.length === 0) throw new Error(`oracle source ${index}.fields must be a non-empty array`);
    const fields = record.fields.map((field) => {
      if (!isSourceField(field)) throw new Error(`oracle source ${index} contains an unsupported field: ${String(field)}`);
      coveredFields.add(field);
      return field;
    });
    if (new Set(fields).size !== fields.length) throw new Error(`oracle source ${index}.fields contains duplicates`);
    if (!isHttpUrl(record.url)) throw new Error(`oracle source ${index}.url must be an HTTP(S) URL`);
    if (typeof record.locator !== "string" || record.locator.trim() === "") throw new Error(`oracle source ${index}.locator must be a non-empty string`);
    if (typeof record.verifiedAt !== "string" || !isIsoDate(record.verifiedAt)) throw new Error(`oracle source ${index}.verifiedAt must be an ISO calendar date`);
    return { fields, url: record.url, locator: record.locator, verifiedAt: record.verifiedAt };
  });
  for (const field of ORACLE_SOURCE_FIELDS) {
    if (!coveredFields.has(field)) throw new Error(`oracle has no authoritative source for ${field}`);
  }
  return { expected, sources };
}

function parseExpectedEnvironment(value: unknown, environment: EnvironmentName): TargetEnvironment {
  const root = requireExactRecord(
    value,
    ["chain", "rpcPolicy", "tokens", "assetOnboarding", "finalityPolicy"],
    `oracle ${environment}`,
  );
  return {
    chain: parseExpectedChain(root.chain, environment),
    rpcPolicy: parseExpectedRpcPolicy(root.rpcPolicy, environment),
    tokens: parseExpectedTokens(root.tokens, environment),
    assetOnboarding: parseExpectedAssetOnboarding(root.assetOnboarding, environment),
    finalityPolicy: parseExpectedFinalityPolicy(root.finalityPolicy, environment),
  };
}

function parseExpectedChain(value: unknown, environment: EnvironmentName): TargetEnvironment["chain"] {
  const chain = requireExactRecord(value, [...CHAIN_KEYS], `oracle ${environment}.chain`);
  if (typeof chain.name !== "string" || chain.name.trim() === "") throw new Error(`oracle ${environment}.chain.name must be a non-empty string`);
  if (!Number.isSafeInteger(chain.chainId) || (chain.chainId as number) <= 0) throw new Error(`oracle ${environment}.chain.chainId must be a positive safe integer`);
  for (const key of ["rpcUrl", "explorerUrl"] as const) {
    if (!isHttpUrl(chain[key])) throw new Error(`oracle ${environment}.chain.${key} must be an HTTP(S) URL`);
  }
  if (chain.deprecatedGoerliFallbackUrl !== null) throw new Error(`oracle ${environment}.chain.deprecatedGoerliFallbackUrl must be null`);
  return chain as TargetEnvironment["chain"];
}

function parseExpectedRpcPolicy(value: unknown, environment: EnvironmentName): TargetEnvironment["rpcPolicy"] {
  const policy = requireExactRecord(value, [...RPC_POLICY_KEYS], `oracle ${environment}.rpcPolicy`);
  for (const key of RPC_ENDPOINT_KEYS) {
    if (!isHttpUrl(policy[key])) throw new Error(`oracle ${environment}.rpcPolicy.${key} must be an HTTP(S) URL`);
  }
  if (policy.sequencerSubmissionOnly !== true) throw new Error(`oracle ${environment}.rpcPolicy.sequencerSubmissionOnly must be true`);
  for (const key of ["sequencerAcceptedMethods", "retryableSubmissionErrors", "terminalSubmissionErrors"] as const) {
    if (!isStringArray(policy[key])) throw new Error(`oracle ${environment}.rpcPolicy.${key} must be a string array`);
  }
  return policy as TargetEnvironment["rpcPolicy"];
}


function parseExpectedTokens(value: unknown, environment: EnvironmentName): TargetEnvironment["tokens"] {
  const tokens = requireExactRecord(value, [...TOKEN_KEYS], `oracle ${environment}.tokens`);
  if (!isAddress(tokens.WETH) || !isAddress(tokens.USDC)) throw new Error(`oracle ${environment}.tokens contains an invalid required address`);
  if (tokens["USDC.e"] !== null && !isAddress(tokens["USDC.e"])) throw new Error(`oracle ${environment}.tokens.USDC.e must be an address or null`);
  return tokens as TargetEnvironment["tokens"];
}

function parseExpectedAssetOnboarding(value: unknown, environment: EnvironmentName): TargetEnvironment["assetOnboarding"] {
  const onboarding = requireExactRecord(value, ["enabled", "preferredRoute", "canonicalBridge"], `oracle ${environment}.assetOnboarding`);
  const bridge = requireExactRecord(onboarding.canonicalBridge, ["enabled", "contracts"], `oracle ${environment}.assetOnboarding.canonicalBridge`);
  const contracts = parseAddressRecord(bridge.contracts, BRIDGE_CONTRACT_KEYS, `oracle ${environment}.assetOnboarding.canonicalBridge.contracts`);
  if (typeof onboarding.enabled !== "boolean") throw new Error(`oracle ${environment}.assetOnboarding.enabled must be boolean`);
  if (onboarding.preferredRoute !== "canonicalBridge") throw new Error(`oracle ${environment}.assetOnboarding.preferredRoute must be canonicalBridge`);
  if (bridge.enabled !== true) throw new Error(`oracle ${environment}.assetOnboarding.canonicalBridge.enabled must be true`);
  return { enabled: onboarding.enabled, preferredRoute: onboarding.preferredRoute, canonicalBridge: { enabled: bridge.enabled, contracts } } as TargetEnvironment["assetOnboarding"];
}

function parseExpectedFinalityPolicy(value: unknown, environment: EnvironmentName): TargetEnvironment["finalityPolicy"] {
  const policy = requireExactRecord(value, [...FINALITY_POLICY_KEYS], `oracle ${environment}.finalityPolicy`);
  if (policy.withdrawalsToEthereumAreInstant !== false) throw new Error(`oracle ${environment}.finalityPolicy.withdrawalsToEthereumAreInstant must be false`);
  for (const key of ["challengeWindowBlocks", "forceIncludePeriodBlocks"] as const) {
    if (!Number.isSafeInteger(policy[key]) || (policy[key] as number) <= 0) throw new Error(`oracle ${environment}.finalityPolicy.${key} must be a positive safe integer`);
  }
  return policy as TargetEnvironment["finalityPolicy"];
}


function parseAddressRecord<K extends string>(value: unknown, keys: readonly K[], label: string): Record<K, string> {
  const record = requireExactRecord(value, [...keys], label);
  for (const key of keys) {
    if (!isAddress(record[key])) throw new Error(`${label}.${key} must be a 20-byte address`);
  }
  return record as Record<K, string>;
}

function gradedZero(reason: string): ValidationOutcome {
  return { status: "graded", score: 0, fullPass: false, checks: CHECK_IDS.map((id) => ({ id, passed: false, message: reason })) };
}

function infrastructureError(error: unknown): ValidationOutcome {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { status: "infrastructure-failure", score: null, fullPass: null, checks: [{ id: "validator-infrastructure", passed: false, message: detail.slice(0, 1_000) }] };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function requireExactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  const record = requireRecord(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  return record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function sameAddress(actual: unknown, expected: string): boolean {
  return isAddress(actual) && actual.toLowerCase() === expected.toLowerCase();
}

function sameNullableAddress(actual: unknown, expected: string | null): boolean {
  return expected === null ? actual === null : sameAddress(actual, expected);
}

function sameUrl(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string") return false;
  try {
    return canonicalUrl(actual) === canonicalUrl(expected);
  } catch {
    return false;
  }
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported URL protocol");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    canonicalUrl(value);
    return true;
  } catch {
    return false;
  }
}
function isSourceField(value: unknown): value is SourceField {
  return typeof value === "string" && (ORACLE_SOURCE_FIELDS as readonly string[]).includes(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
