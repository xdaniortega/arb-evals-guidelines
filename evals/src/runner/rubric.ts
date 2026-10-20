/**
 * Pure scoring rubric engine and schema validation.
 *
 * Host-side only: this module defines the rubric data structures, fail-closed
 * decoding of rubric.json files, and the authoritative weighted scoring function.
 *
 * Rubric v0.2 has two accuracy groups with fixed, framework-owned weights:
 * - `outcome` (80 points): outcome correctness and completeness. Happy-path and
 *   unhappy-path checks are both outcome checks; they are not scored separately.
 * - `constraints` (20 points): constraints and preservation.
 *
 * Group labels and points are framework constants; a case only declares checks
 * (and optional topics). Any other rubric version fails to decode, so a sealed run
 * frozen under an earlier rubric is reported through the legacy branch.
 */

import { EvalError } from "../core/types.ts";
import type { JsonRecord, ValidationCheck } from "../core/types.ts";
import { isRecord, requireKeys } from "../core/types.ts";

export const RUBRIC_VERSION = "v0.2";
export const RUBRIC_GROUPS = ["outcome", "constraints"] as const;
export type RubricGroupId = (typeof RUBRIC_GROUPS)[number];

export const OUTCOME_POINTS = 80;
export const CONSTRAINT_POINTS = 20;

export interface RubricGroupDefinition {
  readonly label: string;
  readonly points: number;
}

/** Fixed accuracy pillars: labels and weights are owned by the framework, not by cases. */
export const ACCURACY_GROUPS: Readonly<Record<RubricGroupId, RubricGroupDefinition>> = {
  outcome: { label: "Outcome correctness and completeness", points: OUTCOME_POINTS },
  constraints: { label: "Constraints and preservation", points: CONSTRAINT_POINTS },
};

export interface RubricCheck {
  readonly id: string;
  readonly group: RubricGroupId;
  readonly points: number;
  readonly topic?: string;
}

export interface RubricTopic {
  readonly id: string;
  readonly label: string;
  readonly points: number;
}

export interface RubricDisplay {
  readonly title: string;
  readonly scenario: string;
}

export interface Rubric {
  readonly rubricVersion: string;
  readonly display?: RubricDisplay;
  readonly checks: readonly RubricCheck[];
  readonly topics?: readonly RubricTopic[];
}

export interface RubricGroupScore {
  readonly got: number;
  readonly max: number;
}

export interface RubricTopicScore {
  readonly id: string;
  readonly label: string;
  readonly got: number;
  readonly max: number;
}

export interface RubricScore {
  readonly rubricVersion: string;
  readonly groups: Readonly<Record<RubricGroupId, RubricGroupScore>>;
  readonly topics: readonly RubricTopicScore[];
  readonly accuracyTotal: number;
  readonly score: number;
  readonly fullPass: boolean;
}

/** Sentinel check ID used by validator infrastructure errors; excluded from check matching. */
export const VALIDATOR_INFRASTRUCTURE_SENTINEL = "validator-infrastructure";

function invalid(message: string, at: string): EvalError {
  return new EvalError("input-invalid", message, { at });
}

function requireLabel(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(`${at} must be a non-empty string`, at);
  }
  return value;
}

function requirePoints(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${at} must be a positive integer`, at);
  }
  return value;
}

function decodeDisplay(value: unknown, at: string): RubricDisplay {
  const display = requireKeys(value, { required: ["title", "scenario"] }, at);
  return {
    title: requireLabel(display.title, `${at}.title`),
    scenario: requireLabel(display.scenario, `${at}.scenario`),
  };
}

function decodeTopics(value: unknown, at: string): RubricTopic[] {
  if (!Array.isArray(value)) {
    throw invalid(`${at} must be an array`, at);
  }
  const seen = new Set<string>();
  return value.map((rawItem, index) => {
    const topicAt = `${at}[${index}]`;
    const item = requireKeys(rawItem, { required: ["id", "label", "points"] }, topicAt);
    const id = requireLabel(item.id, `${topicAt}.id`);
    if (seen.has(id)) {
      throw invalid(`${topicAt}.id duplicate topic ID: ${id}`, `${topicAt}.id`);
    }
    seen.add(id);
    return { id, label: requireLabel(item.label, `${topicAt}.label`), points: requirePoints(item.points, `${topicAt}.points`) };
  });
}

function decodeCheck(rawItem: unknown, topicIds: ReadonlySet<string>, at: string): RubricCheck {
  const item = requireKeys(rawItem, { required: ["id", "group", "points"], optional: ["topic"] }, at);
  const id = requireLabel(item.id, `${at}.id`);
  if (typeof item.group !== "string" || !(RUBRIC_GROUPS as readonly string[]).includes(item.group)) {
    throw invalid(`${at}.group must be one of: ${RUBRIC_GROUPS.join(", ")}`, `${at}.group`);
  }
  const points = requirePoints(item.points, `${at}.points`);
  if (item.topic === undefined) {
    return { id, group: item.group as RubricGroupId, points };
  }
  const topic = requireLabel(item.topic, `${at}.topic`);
  if (!topicIds.has(topic)) {
    throw invalid(`${at}.topic references undefined topic: ${topic}`, `${at}.topic`);
  }
  return { id, group: item.group as RubricGroupId, points, topic };
}

/**
 * Decodes and strictly validates a rubric v0.2 definition from untrusted JSON.
 * Fails closed on a wrong version, schema error, point mismatch, duplicate ID, or unknown keys.
 */
export function decodeRubric(json: unknown, at = "rubric.json"): Rubric {
  const root: JsonRecord = requireKeys(json, { required: ["rubricVersion", "checks"], optional: ["display", "topics"] }, at);
  if (root.rubricVersion !== RUBRIC_VERSION) {
    throw invalid(`${at}.rubricVersion must be "${RUBRIC_VERSION}"`, `${at}.rubricVersion`);
  }
  const display = root.display === undefined ? undefined : decodeDisplay(root.display, `${at}.display`);
  const topics = root.topics === undefined ? undefined : decodeTopics(root.topics, `${at}.topics`);

  if (!Array.isArray(root.checks) || root.checks.length === 0) {
    throw invalid(`${at}.checks must be a non-empty array`, `${at}.checks`);
  }
  const topicIds = new Set((topics ?? []).map((t) => t.id));
  const checkIds = new Set<string>();
  const groupSums: Record<RubricGroupId, number> = { outcome: 0, constraints: 0 };
  const topicSums = new Map<string, number>();
  const checks = root.checks.map((rawItem, index) => {
    const checkAt = `${at}.checks[${index}]`;
    const check = decodeCheck(rawItem, topicIds, checkAt);
    if (checkIds.has(check.id)) {
      throw invalid(`${checkAt}.id duplicate check ID: ${check.id}`, `${checkAt}.id`);
    }
    checkIds.add(check.id);
    groupSums[check.group] += check.points;
    if (check.topic !== undefined) topicSums.set(check.topic, (topicSums.get(check.topic) ?? 0) + check.points);
    return check;
  });

  for (const groupId of RUBRIC_GROUPS) {
    const expected = ACCURACY_GROUPS[groupId].points;
    if (groupSums[groupId] !== expected) {
      throw invalid(
        `${at}: check points for group '${groupId}' sum to ${groupSums[groupId]}; must be ${expected}`,
        `${at}.checks`,
      );
    }
  }
  for (const topic of topics ?? []) {
    const actual = topicSums.get(topic.id) ?? 0;
    if (actual !== topic.points) {
      throw invalid(
        `${at}: check points for topic '${topic.id}' sum to ${actual}; declared topic points are ${topic.points}`,
        `${at}.topics`,
      );
    }
  }

  return {
    rubricVersion: RUBRIC_VERSION,
    ...(display !== undefined ? { display } : {}),
    checks,
    ...(topics !== undefined ? { topics } : {}),
  };
}

/** True when `value` is a sealed rubric v0.2 score (outcome + constraints groups). */
export function isRubricScore(value: unknown): value is RubricScore {
  if (!isRecord(value) || !isRecord(value.groups)) return false;
  const isGroup = (g: unknown): boolean => isRecord(g) && typeof g.got === "number" && typeof g.max === "number";
  return (
    value.rubricVersion === RUBRIC_VERSION &&
    isGroup(value.groups.outcome) &&
    isGroup(value.groups.constraints) &&
    Array.isArray(value.topics) &&
    typeof value.accuracyTotal === "number"
  );
}

/**
 * Computes the authoritative weighted score given a frozen rubric and validator check results.
 *
 * - Rejects duplicate returned check IDs, unknown IDs, and missing declared checks as protocol drift.
 * - Excludes the sentinel `validator-infrastructure` check from matching.
 * - Binary checks; failed checks retain their weight in the denominator (no reweighting).
 * - accuracyTotal in 0..100, score = accuracyTotal / 100, fullPass = all declared checks passed.
 * - Infrastructure failures MUST NOT be passed to this function (caller ensures).
 */
export function scoreWithRubric(rubric: Rubric, returnedChecks: readonly ValidationCheck[]): RubricScore {
  const declaredIds = new Set(rubric.checks.map((c) => c.id));
  const returned = new Map<string, ValidationCheck>();

  for (const [index, c] of returnedChecks.entries()) {
    if (c.id === VALIDATOR_INFRASTRUCTURE_SENTINEL) continue;
    if (returned.has(c.id)) {
      throw new EvalError("protocol-drift", `returned checks contain duplicate check ID: ${c.id}`, { at: `checks[${index}].id` });
    }
    if (!declaredIds.has(c.id)) {
      throw new EvalError("protocol-drift", `returned check ID '${c.id}' is unknown in frozen rubric`, { at: `checks[${index}].id` });
    }
    returned.set(c.id, c);
  }
  for (const declaredId of declaredIds) {
    if (!returned.has(declaredId)) {
      throw new EvalError("protocol-drift", `frozen rubric check '${declaredId}' is missing from returned checks`, {
        at: `checks.${declaredId}`,
      });
    }
  }

  const groupGot: Record<RubricGroupId, number> = { outcome: 0, constraints: 0 };
  const topicGot = new Map<string, number>();
  let fullPass = true;
  for (const check of rubric.checks) {
    if (!returned.get(check.id)!.passed) {
      fullPass = false;
      continue;
    }
    groupGot[check.group] += check.points;
    if (check.topic !== undefined) topicGot.set(check.topic, (topicGot.get(check.topic) ?? 0) + check.points);
  }

  const accuracyTotal = groupGot.outcome + groupGot.constraints;
  return {
    rubricVersion: rubric.rubricVersion,
    groups: {
      outcome: { got: groupGot.outcome, max: OUTCOME_POINTS },
      constraints: { got: groupGot.constraints, max: CONSTRAINT_POINTS },
    },
    topics: (rubric.topics ?? []).map((t) => ({ id: t.id, label: t.label, got: topicGot.get(t.id) ?? 0, max: t.points })),
    accuracyTotal,
    score: accuracyTotal / 100,
    fullPass,
  };
}
