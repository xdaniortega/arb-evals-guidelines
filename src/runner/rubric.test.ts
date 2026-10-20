import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateSnapshot } from "../../eval-cases/arbitrum-docs/network-config-01/validator.ts";
import { EvalError } from "../core/types.ts";
import { ACCURACY_GROUPS, decodeRubric, isRubricScore, scoreWithRubric } from "./rubric.ts";

const NETWORK_CONFIG_01_RUBRIC_PATH = fileURLToPath(
  new URL("../../eval-cases/arbitrum-docs/network-config-01/rubric.json", import.meta.url),
);

// Outcome 50 + 30 = 80, constraints 20.
const rubricJson = {
  rubricVersion: "v0.2",
  topics: [
    { id: "topic-a", label: "Topic A", points: 50 },
    { id: "topic-b", label: "Topic B", points: 30 },
  ],
  checks: [
    { id: "outcome-1", group: "outcome", topic: "topic-a", points: 25 },
    { id: "outcome-2", group: "outcome", topic: "topic-a", points: 25 },
    { id: "outcome-unhappy", group: "outcome", topic: "topic-b", points: 30 },
    { id: "const-1", group: "constraints", points: 10 },
    { id: "const-2", group: "constraints", points: 10 },
  ],
};

const ALL_IDS = rubricJson.checks.map((c) => c.id);
const results = (failing: readonly string[] = []) =>
  ALL_IDS.map((id) => ({ id, passed: !failing.includes(id), message: "" }));

describe("rubric v0.2 scoring and validation", () => {
  describe("decodeRubric", () => {
    it("decodes a valid v0.2 rubric; group labels and weights are runner constants", () => {
      const rubric = decodeRubric(rubricJson);
      expect(rubric.rubricVersion).toBe("v0.2");
      expect(rubric.checks).toHaveLength(5);
      expect(rubric.display).toBeUndefined();
      expect(rubric).not.toHaveProperty("groups");
      expect(ACCURACY_GROUPS.outcome).toEqual({ label: "Outcome correctness and completeness", points: 80 });
      expect(ACCURACY_GROUPS.constraints).toEqual({ label: "Constraints and preservation", points: 20 });
    });

    it("decodes an optional display block and makes topics optional", () => {
      const display = { title: "t", scenario: "s" };
      const { topics: _topics, ...rest } = rubricJson;
      const noTopics = { ...rest, display, checks: rubricJson.checks.map(({ topic: _t, ...c }) => c) };
      const rubric = decodeRubric(noTopics);
      expect(rubric.display).toEqual(display);
      expect(rubric.topics).toBeUndefined();
    });

    it.each([
      ["missing version", { ...rubricJson, rubricVersion: undefined }, "missing required field(s): rubricVersion"],
      ["v1 version", { ...rubricJson, rubricVersion: "v1" }, 'rubricVersion must be "v0.2"'],
      ["v2 version", { ...rubricJson, rubricVersion: "v2" }, 'rubricVersion must be "v0.2"'],
    ])("rejects a wrong rubricVersion (%s)", (_name, json, message) => {
      expect(() => decodeRubric(json)).toThrowError(EvalError);
      expect(() => decodeRubric(json)).toThrow(message);
    });

    it("rejects an outcome sum other than 80", () => {
      const bad = { ...rubricJson, topics: undefined, checks: [
        { id: "o", group: "outcome", points: 70 },
        { id: "c", group: "constraints", points: 20 },
      ] };
      expect(() => decodeRubric(bad)).toThrow("group 'outcome' sum to 70; must be 80");
    });

    it("rejects a constraints sum other than 20", () => {
      const bad = { ...rubricJson, topics: undefined, checks: [
        { id: "o", group: "outcome", points: 80 },
        { id: "c", group: "constraints", points: 15 },
      ] };
      expect(() => decodeRubric(bad)).toThrow("group 'constraints' sum to 15; must be 20");
    });

    it("rejects an unknown group such as the retired 'normal'", () => {
      const bad = { ...rubricJson, checks: [{ ...rubricJson.checks[0], group: "normal" }, ...rubricJson.checks.slice(1)] };
      expect(() => decodeRubric(bad)).toThrow("group must be one of: outcome, constraints");
    });

    it("rejects leftover groups and accuracy blocks", () => {
      expect(() => decodeRubric({ ...rubricJson, groups: {} })).toThrow("unknown field(s): groups");
      expect(() => decodeRubric({ ...rubricJson, accuracy: {} })).toThrow("unknown field(s): accuracy");
    });

    it("rejects unknown keys in display, checks and topics", () => {
      expect(() => decodeRubric({ ...rubricJson, display: { title: "t", scenario: "s", x: 1 } })).toThrow("unknown field(s): x");
      expect(() => decodeRubric({ ...rubricJson, checks: [{ ...rubricJson.checks[0], x: 1 }, ...rubricJson.checks.slice(1)] }))
        .toThrow("rubric.json.checks[0] has unknown field(s): x");
      expect(() => decodeRubric({ ...rubricJson, topics: [{ ...rubricJson.topics[0], x: 1 }, rubricJson.topics[1]] }))
        .toThrow("rubric.json.topics[0] has unknown field(s): x");
    });

    it("rejects empty display fields", () => {
      expect(() => decodeRubric({ ...rubricJson, display: { title: " ", scenario: "s" } })).toThrow("title must be a non-empty string");
    });

    it("rejects duplicate check and topic IDs", () => {
      expect(() => decodeRubric({ ...rubricJson, checks: [...rubricJson.checks, rubricJson.checks[3]] })).toThrow("duplicate check ID");
      expect(() => decodeRubric({ ...rubricJson, topics: [...rubricJson.topics, rubricJson.topics[0]] })).toThrow("duplicate topic ID");
    });

    it("rejects checks referencing undefined topics and topic sum mismatches", () => {
      expect(() => decodeRubric({ ...rubricJson, checks: [{ ...rubricJson.checks[0], topic: "nope" }, ...rubricJson.checks.slice(1)] }))
        .toThrow("undefined topic");
      expect(() => decodeRubric({ ...rubricJson, topics: [{ ...rubricJson.topics[0], points: 60 }, rubricJson.topics[1]] }))
        .toThrow("declared topic points are 60");
    });

    it("rejects empty checks and non-positive points", () => {
      expect(() => decodeRubric({ ...rubricJson, checks: [] })).toThrow("checks must be a non-empty array");
      expect(() => decodeRubric({ ...rubricJson, checks: [{ ...rubricJson.checks[0], points: 0 }, ...rubricJson.checks.slice(1)] }))
        .toThrow("points must be a positive integer");
    });
  });

  describe("scoreWithRubric", () => {
    it("computes the full 80/20 split", () => {
      const result = scoreWithRubric(decodeRubric(rubricJson), results());
      expect(result.rubricVersion).toBe("v0.2");
      expect(result.groups).toEqual({ outcome: { got: 80, max: 80 }, constraints: { got: 20, max: 20 } });
      expect(result.accuracyTotal).toBe(100);
      expect(result.score).toBe(1);
      expect(result.fullPass).toBe(true);
      expect(isRubricScore(result)).toBe(true);
    });

    it("treats an unhappy-path check as a regular outcome check; failed checks keep their weight", () => {
      const result = scoreWithRubric(decodeRubric(rubricJson), results(["outcome-unhappy"]));
      expect(result.groups.outcome).toEqual({ got: 50, max: 80 });
      expect(result.groups.constraints).toEqual({ got: 20, max: 20 });
      expect(result.accuracyTotal).toBe(70);
      expect(result.score).toBe(0.7);
      expect(result.fullPass).toBe(false);
    });

    it("returns per-topic breakdown", () => {
      const result = scoreWithRubric(decodeRubric(rubricJson), results(["outcome-2", "const-1"]));
      expect(result.topics).toEqual([
        { id: "topic-a", label: "Topic A", got: 25, max: 50 },
        { id: "topic-b", label: "Topic B", got: 30, max: 30 },
      ]);
      expect(result.accuracyTotal).toBe(65);
    });

    it("ignores the validator-infrastructure sentinel during matching", () => {
      const result = scoreWithRubric(decodeRubric(rubricJson), [
        { id: "validator-infrastructure", passed: true, message: "" },
        ...results(),
      ]);
      expect(result.accuracyTotal).toBe(100);
    });

    it("raises protocol drift on duplicate, unknown, and missing checks", () => {
      const rubric = decodeRubric(rubricJson);
      expect(() => scoreWithRubric(rubric, [...results(), results()[0]!])).toThrow("duplicate check ID");
      expect(() => scoreWithRubric(rubric, [...results(), { id: "extra", passed: true, message: "" }])).toThrow("unknown in frozen rubric");
      expect(() => scoreWithRubric(rubric, results().slice(1))).toThrow("is missing from returned checks");
    });

    it("isRubricScore rejects scores sealed under earlier rubrics", () => {
      expect(isRubricScore({
        rubricVersion: "v1",
        groups: { normal: { got: 0, max: 80 }, unhappy: { got: 0, max: 0 }, constraints: { got: 0, max: 20 } },
        topics: [],
        accuracyTotal: 0,
      })).toBe(false);
      expect(isRubricScore(null)).toBe(false);
    });

    it("infrastructure-failure stays ungraded and is never scored by scoreWithRubric", () => {
      const infraOutcome = validateSnapshot({ outputPath: "config.json", fixtureFiles: {}, candidateFiles: {}, oracle: {} });
      expect(infraOutcome.status).toBe("infrastructure-failure");
      expect(infraOutcome.score).toBeNull();
      expect(infraOutcome.checks[0]?.id).toBe("validator-infrastructure");
    });

    it("pins the scoring endpoints of the real network-config-01 rubric", async () => {
      const json = JSON.parse(await readFile(NETWORK_CONFIG_01_RUBRIC_PATH, "utf8")) as unknown;
      const rubric = decodeRubric(json, "eval-cases/arbitrum-docs/network-config-01/rubric.json");
      expect(rubric.rubricVersion).toBe("v0.2");
      expect(rubric.display).toEqual({
        title: "network configuration migration",
        scenario: "Migrate production and staging network configuration to Arbitrum",
      });
      expect(rubric.checks.filter((c) => c.group === "outcome")).toHaveLength(16);
      expect(rubric.checks.filter((c) => c.group === "constraints").map((c) => c.id)).toEqual(["json-shape", "preservation"]);

      const ids = rubric.checks.map((c) => c.id);
      const correct = scoreWithRubric(rubric, ids.map((id) => ({ id, passed: true, message: "" })));
      expect(correct.accuracyTotal).toBe(100);
      expect(correct.fullPass).toBe(true);

      const unchanged = scoreWithRubric(rubric, ids.map((id) => ({ id, passed: id === "json-shape" || id === "preservation", message: "" })));
      expect(unchanged.groups).toEqual({ outcome: { got: 0, max: 80 }, constraints: { got: 20, max: 20 } });
      expect(unchanged.accuracyTotal).toBe(20);

      const malformed = scoreWithRubric(rubric, ids.map((id) => ({ id, passed: false, message: "" })));
      expect(malformed.accuracyTotal).toBe(0);
    });
  });
});
