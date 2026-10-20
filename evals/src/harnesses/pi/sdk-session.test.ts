/**
 * L1 Integration Tests: Real Pi SDK and Pinned HTML Exporter without API Calls.
 *
 * Covers the in-guest SDK session contract:
 *
 * THE NARROW TEST BOUNDARY:
 * - Instantiates the ACTUAL pinned SDK session (@earendil-works/pi-coding-agent@0.85.0).
 * - Replaces ONLY `ModelRuntime.streamSimple` at the test boundary with a scripted native event stream.
 * - Does NOT mock or replace `createAgentSession`, the tool loop, resource discovery, or SessionManager.
 *
 * HONEST LIMIT STATEMENT:
 * Mocking completion proves target wiring and SDK behaviour — it does NOT prove
 * live authentication, provider wire-protocol compatibility, quotas, latency or skill quality.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Target } from "../../core/experiment.ts";
import { EvalError } from "../../core/types.ts";
import {
  installTestGuards,
  RealCompletionTransportBlockedError,
} from "../../test-guards.ts";
import {
  createSanitizedSessionCopy,
  exportSessionFileToHtml,
  verifyExportedHtml,
} from "./export-viewer.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createScriptedStreamSimple } from "./scripted-stream.ts";
import { createPiSdkSession } from "./sdk-session.ts";
import { buildAmbientTools } from "./ambient-tools.ts";
import { createMcpStub } from "./mcp-stub.test-helper.ts";
import type { SkillToolBundle } from "../../core/skill-tools.ts";

function sha256File(path: string): string {
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Phase 2: Pi SDK Guest Wrapper and Native Session Integration (L1)", () => {
  let tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    installTestGuards();
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    }
    tempDirs = [];
  });

  describe("Real tool effects & multi-turn native conversation", () => {
    it("causes real read, write, edit tool effects on disk and records full native turn history", async () => {
      const workspace = makeTempDir("pi-tool-effects");
      // 1. Initial fixture file
      writeFileSync(join(workspace, "greeting.txt"), "Hello, Arbitrum Developer!\n");

      // 2. Multi-turn scripted model sequence:
      //    Turn 1: toolCall 'read' on greeting.txt
      //    Turn 2: toolCall 'write' to create new-greeting.txt
      //    Turn 3: toolCall 'edit' to edit new-greeting.txt (find/replace)
      //    Turn 4: final assistant text
      const scriptedStream = createScriptedStreamSimple([
        {
          type: "toolCall",
          toolCalls: [
            {
              id: "call_read_1",
              name: "read",
              arguments: { path: "greeting.txt" },
            },
          ],
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
        {
          type: "toolCall",
          toolCalls: [
            {
              id: "call_write_2",
              name: "write",
              arguments: { path: "new-greeting.txt", content: "Original generated text" },
            },
          ],
          usage: { input: 20, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 28, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
        {
          type: "toolCall",
          toolCalls: [
            {
              id: "call_edit_3",
              name: "edit",
              arguments: { path: "new-greeting.txt", oldText: "Original", newText: "Polished" },
            },
          ],
          usage: { input: 30, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 38, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
        {
          type: "text",
          text: "I have read greeting.txt, written new-greeting.txt, and edited it to say Polished.",
          usage: { input: 40, output: 15, cacheRead: 0, cacheWrite: 0, totalTokens: 55, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      ]);

      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };
      const sessionInstance = await createPiSdkSession({
        cwd: workspace,
        arm: "baseline",
        target,
        streamSimpleOverride: scriptedStream,
      });

      // Pre-prompt attestation on the SAME session instance
      const attestation = sessionInstance.attest();
      expect(attestation.arm).toBe("baseline");
      expect(attestation.target.provider).toBe("google");
      expect(attestation.target.model).toBe("gemini-3.8-flash");
      expect(attestation.loadedSkills.length).toBe(0);
      expect(attestation.retryEnabled).toBe(false);
      expect(attestation.compactionEnabled).toBe(false);

      // Execute prompt on THAT SAME session
      await sessionInstance.runPrompt("Read greeting.txt, write new-greeting.txt, and edit it.");

      // Verify ACTUAL on-disk effects
      expect(existsSync(join(workspace, "new-greeting.txt"))).toBe(true);
      const fileOnDisk = readFileSync(join(workspace, "new-greeting.txt"), "utf8");
      expect(fileOnDisk).toBe("Polished generated text");

      // Verify native session conversation entries
      const session = sessionInstance.session;
      const messages = session.messages;
      expect(messages.length).toBe(8); // user, asst(read), tool(read), asst(write), tool(write), asst(edit), tool(edit), asst(text)

      expect(messages[0]!.role).toBe("user");
      expect(messages[1]!.role).toBe("assistant");
      expect(messages[2]!.role).toBe("toolResult");
      expect((messages[2] as any).toolCallId).toBe("call_read_1");

      expect(messages[3]!.role).toBe("assistant");
      expect(messages[4]!.role).toBe("toolResult");
      expect((messages[4] as any).toolCallId).toBe("call_write_2");

      expect(messages[5]!.role).toBe("assistant");
      expect(messages[6]!.role).toBe("toolResult");
      expect((messages[6] as any).toolCallId).toBe("call_edit_3");

      expect(messages[7]!.role).toBe("assistant");
      expect((messages[7] as any).content[0].text).toContain("Polished");

      // Export session to HTML and verify that intermediate messages and tool result IDs survive
      const sessionFile = sessionInstance.sessionFile!;
      expect(existsSync(sessionFile)).toBe(true);

      const htmlPath = join(workspace, "session-export.html");
      await exportSessionFileToHtml(sessionFile, htmlPath);
      expect(existsSync(htmlPath)).toBe(true);

      const verification = verifyExportedHtml(htmlPath);
      expect(verification.valid).toBe(true);
      const decodedJson = JSON.stringify(verification.decodedSessionJson);
      expect(decodedJson).toContain("call_read_1");
      expect(decodedJson).toContain("call_write_2");
      expect(decodedJson).toContain("call_edit_3");
      expect(decodedJson).toContain("greeting.txt");
      expect(decodedJson).toContain("Polished generated text");

      sessionInstance.dispose();
    });
  });

  describe("Workspace flexibility & synthetic test cases", () => {
    it("starts in an empty workspace and creates nested output files", async () => {
      const emptyWorkspace = makeTempDir("pi-empty-workspace");
      // Workspace is genuinely empty
      expect(existsSync(join(emptyWorkspace, "sub"))).toBe(false);

      const scriptedStream = createScriptedStreamSimple([
        {
          type: "toolCall",
          toolCalls: [
            {
              id: "call_nested_write",
              name: "write",
              arguments: {
                path: "nested/deep/directory/result.json",
                content: JSON.stringify({ status: "success", step: "nested-file" }, null, 2),
              },
            },
          ],
        },
        {
          type: "text",
          text: "Created nested directory and file.",
        },
      ]);

      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };
      const sessionInstance = await createPiSdkSession({
        cwd: emptyWorkspace,
        arm: "baseline",
        target,
        streamSimpleOverride: scriptedStream,
      });

      await sessionInstance.runPrompt("Create nested/deep/directory/result.json");

      const createdFile = join(emptyWorkspace, "nested/deep/directory/result.json");
      expect(existsSync(createdFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(createdFile, "utf8"));
      expect(parsed.status).toBe("success");
      expect(parsed.step).toBe("nested-file");

      sessionInstance.dispose();
    });

    it("can inspect and edit a multi-file fixture", async () => {
      const fixtureWorkspace = makeTempDir("pi-multi-file-fixture");
      mkdirSync(join(fixtureWorkspace, "src"), { recursive: true });
      writeFileSync(join(fixtureWorkspace, "src/config.ts"), "export const TIMEOUT = 1000;\n");
      writeFileSync(join(fixtureWorkspace, "src/main.ts"), "import { TIMEOUT } from './config.ts';\nconsole.log(TIMEOUT);\n");

      const scriptedStream = createScriptedStreamSimple([
        {
          type: "toolCall",
          toolCalls: [
            {
              id: "call_read_config",
              name: "read",
              arguments: { path: "src/config.ts" },
            },
          ],
        },
        {
          type: "toolCall",
          toolCalls: [
            {
              id: "call_edit_config",
              name: "edit",
              arguments: { path: "src/config.ts", oldText: "1000", newText: "5000" },
            },
          ],
        },
        {
          type: "text",
          text: "Updated TIMEOUT from 1000 to 5000 in src/config.ts.",
        },
      ]);

      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };
      const sessionInstance = await createPiSdkSession({
        cwd: fixtureWorkspace,
        arm: "baseline",
        target,
        streamSimpleOverride: scriptedStream,
      });

      await sessionInstance.runPrompt("Inspect src/config.ts and update TIMEOUT to 5000.");

      // Check that src/config.ts was edited while src/main.ts was untouched
      const configText = readFileSync(join(fixtureWorkspace, "src/config.ts"), "utf8");
      expect(configText).toBe("export const TIMEOUT = 5000;\n");
      const mainText = readFileSync(join(fixtureWorkspace, "src/main.ts"), "utf8");
      expect(mainText).toBe("import { TIMEOUT } from './config.ts';\nconsole.log(TIMEOUT);\n");

      sessionInstance.dispose();
    });
  });

  describe("Skill isolation & ambient suppression", () => {
    it("baseline loads NO evaluated skill; treatment loads exactly the frozen skill; ambient resources are absent", async () => {
      const testRoot = makeTempDir("pi-skill-isolation");
      const workspace = join(testRoot, "workspace");
      mkdirSync(workspace);

      // Create ambient pollution in workspace and parent:
      // 1. Ambient AGENTS.md in workspace
      writeFileSync(join(workspace, "AGENTS.md"), "# Ambient Workspace Instructions\n");
      // 2. Ambient CLAUDE.md in parent
      writeFileSync(join(testRoot, "CLAUDE.md"), "# Ambient Claude Instructions\n");

      // 3. Frozen evaluated skill
      const frozenSkillDir = join(testRoot, "frozen-arbitrum-skill");
      mkdirSync(frozenSkillDir);
      writeFileSync(
        join(frozenSkillDir, "SKILL.md"),
        "---\nname: arbitrum-docs\ndescription: Arbitrum documentation search\n---\n# Arbitrum Docs Skill\n",
      );

      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };

      // --- BASELINE ARM ---
      const baselineInstance = await createPiSdkSession({
        cwd: workspace,
        arm: "baseline",
        target,
        streamSimpleOverride: createScriptedStreamSimple([
          { type: "text", text: "Baseline response with no skill" },
        ]),
      });

      const baselineAttest = baselineInstance.attest();
      expect(baselineAttest.arm).toBe("baseline");
      expect(baselineAttest.loadedSkills.length).toBe(0);
      expect(baselineAttest.activeTools).not.toContain("mcp");
      expect(baselineAttest.mcpClientId).toBeNull();
      expect(baselineAttest.agentsFilesCount).toBe(0);
      expect(baselineAttest.extensionsCount).toBe(0);
      expect(baselineAttest.promptsCount).toBe(0);

      await baselineInstance.runPrompt("Perform task");
      expect(baselineInstance.resourceLoader.getSkills().skills.length).toBe(0);
      baselineInstance.dispose();

      // --- TREATMENT ARM ---
      const treatmentInstance = await createPiSdkSession({
        cwd: workspace,
        arm: "treatment",
        target,
        skillPath: frozenSkillDir,
        streamSimpleOverride: createScriptedStreamSimple([
          { type: "text", text: "Treatment response with frozen skill" },
        ]),
      });

      const treatmentAttest = treatmentInstance.attest();
      expect(treatmentAttest.arm).toBe("treatment");
      expect(treatmentAttest.loadedSkills.length).toBe(1);
      expect(treatmentAttest.loadedSkills[0]!.name).toBe("arbitrum-docs");
      expect(treatmentAttest.activeTools).not.toContain("mcp");
      expect(treatmentAttest.mcpClientId).toBeNull();
      expect(treatmentAttest.agentsFilesCount).toBe(0);
      expect(treatmentAttest.extensionsCount).toBe(0);
      expect(treatmentAttest.promptsCount).toBe(0);

      await treatmentInstance.runPrompt("Perform task");
      expect(treatmentInstance.resourceLoader.getSkills().skills.length).toBe(1);
      expect(treatmentInstance.resourceLoader.getSkills().skills[0]!.name).toBe("arbitrum-docs");
      treatmentInstance.dispose();
    });
  });

  describe("Target selection & thinking configuration", () => {
    // HONEST LIMIT STATEMENT: Parameterizing Google and Anthropic target selection
    // proves target wiring and SDK configuration — it does NOT prove live authentication,
    // provider wire-protocol compatibility, quotas, latency or skill quality.

    const validTargets: Target[] = [
      { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
      { provider: "google", model: "gemini-2.5-flash", thinking: "medium" },
      { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "low" },
      { provider: "anthropic", model: "claude-opus-4-6", thinking: "high" },
    ];

    for (const target of validTargets) {
      it(`accepts valid target wiring for ${target.provider}/${target.model} (${target.thinking})`, async () => {
        const workspace = makeTempDir("pi-target-valid");
        const instance = await createPiSdkSession({
          cwd: workspace,
          arm: "baseline",
          target,
          streamSimpleOverride: createScriptedStreamSimple([
            { type: "text", text: `Target ${target.model} initialized successfully` },
          ]),
        });

        const attestation = instance.attest();
        expect(attestation.providerId).toBe(target.provider);
        expect(attestation.modelId).toBe(target.model);
        expect(attestation.thinkingLevel).toBe(target.thinking);

        await instance.runPrompt("Status check");
        expect(instance.session.messages.length).toBe(2);
        instance.dispose();
      });
    }

    const invalidTargets: Array<{ target: Target; errorReason: string }> = [
      {
        target: { provider: "openai" as any, model: "gpt-4o", thinking: "low" },
        errorReason: "unsupported provider",
      },
      {
        target: { provider: "google", model: "gemini-unknown-model", thinking: "low" },
        errorReason: "unknown model",
      },
      {
        target: { provider: "google", model: "gemini-flash-latest", thinking: "low" },
        errorReason: "moving alias disallowed",
      },
      {
        target: { provider: "google", model: "gemini-3-flash-preview", thinking: "low" },
        errorReason: "preview model disallowed",
      },
      {
        target: { provider: "google", model: "gemini-3.8-flash", thinking: "off" },
        errorReason: "coerced thinking rejected by Google",
      },
      {
        target: { provider: "google", model: "gemini-3.8-flash", thinking: "minimal" },
        errorReason: "minimal thinking rejected by Google",
      },
      {
        target: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "max" },
        errorReason: "max thinking not supported by sonnet-4-5",
      },
      {
        target: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "nonexistent-level" as any },
        errorReason: "invalid thinking level string",
      },
    ];

    for (const { target, errorReason } of invalidTargets) {
      it(`fails before prompt with no fallback when target is invalid: ${errorReason} (${target.provider}/${target.model})`, async () => {
        const workspace = makeTempDir("pi-target-invalid");
        await expect(
          createPiSdkSession({
            cwd: workspace,
            arm: "baseline",
            target,
            streamSimpleOverride: createScriptedStreamSimple([]),
          }),
        ).rejects.toThrow(EvalError);
      });
    }
  });

  describe("Lifecycle events, synthetic errors, stops, and missing usage", () => {
    it("handles synthetic model errors cleanly without silent retry", async () => {
      const workspace = makeTempDir("pi-model-error");
      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };

      const instance = await createPiSdkSession({
        cwd: workspace,
        arm: "baseline",
        target,
        streamSimpleOverride: createScriptedStreamSimple([
          { type: "error", errorMessage: "Synthetic upstream quota exceeded (429)" },
        ]),
      });

      // Prompt executes and settles with the error state recorded in session
      await instance.runPrompt("Trigger error");

      // Session records the error and did not attempt automatic retry
      const messages = instance.session.messages;
      const lastMsg = messages[messages.length - 1];
      expect(lastMsg?.role).toBe("assistant");
      expect((lastMsg as any)?.stopReason).toBe("error");
      expect((lastMsg as any)?.errorMessage).toContain("quota exceeded (429)");

      instance.dispose();
    });

    it("handles tool execution errors cleanly", async () => {
      const workspace = makeTempDir("pi-tool-error");
      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };

      const instance = await createPiSdkSession({
        cwd: workspace,
        arm: "baseline",
        target,
        streamSimpleOverride: createScriptedStreamSimple([
          // Turn 1: try to read non-existent file
          {
            type: "toolCall",
            toolCalls: [
              {
                id: "call_err_1",
                name: "read",
                arguments: { path: "nonexistent-file.txt" },
              },
            ],
          },
          // Turn 2: model observes tool error and replies
          {
            type: "text",
            text: "The file was not found, so I stopped.",
          },
        ]),
      });

      await instance.runPrompt("Read nonexistent-file.txt");

      const messages = instance.session.messages;
      expect(messages.length).toBe(4);
      expect(messages[1]!.role).toBe("assistant");
      expect(messages[2]!.role).toBe("toolResult");
      expect((messages[2] as any).isError).toBe(true);
      expect(messages[3]!.role).toBe("assistant");
      expect((messages[3] as any).content[0].text).toContain("not found");

      instance.dispose();
    });

    it("represents task budget stops (length limit) accurately", async () => {
      const workspace = makeTempDir("pi-task-stop");
      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };

      const instance = await createPiSdkSession({
        cwd: workspace,
        arm: "baseline",
        target,
        streamSimpleOverride: createScriptedStreamSimple([
          {
            type: "stop",
            stopReason: "length",
            text: "Truncated output due to max_tokens limit",
            usage: { input: 100, output: 8192, cacheRead: 0, cacheWrite: 0, totalTokens: 8292, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          },
        ]),
      });

      await instance.runPrompt("Generate very long text");

      const lastMsg = instance.session.messages[instance.session.messages.length - 1];
      expect((lastMsg as any).stopReason).toBe("length");
      expect((lastMsg as any).content[0].text).toContain("Truncated");
      expect((lastMsg as any).usage.output).toBe(8192);

      instance.dispose();
    });

    it("handles missing usage telemetry without crashing or inventing numbers", async () => {
      const workspace = makeTempDir("pi-missing-usage");
      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };

      const instance = await createPiSdkSession({
        cwd: workspace,
        arm: "baseline",
        target,
        streamSimpleOverride: createScriptedStreamSimple([
          {
            type: "text",
            text: "Response with omitted token usage",
          },
        ]),
      });

      await instance.runPrompt("Hello");

      const lastMsg = instance.session.messages[instance.session.messages.length - 1];
      expect((lastMsg as any).content[0].text).toBe("Response with omitted token usage");
      expect(lastMsg).not.toHaveProperty("usage");
      expect(instance.getBudgetSnapshot()).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      });

      instance.dispose();
    });

    it("handles explicit session cancellation", async () => {
      const workspace = makeTempDir("pi-cancel");
      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };

      let abortReceived = false;
      let sessionInstance: Awaited<ReturnType<typeof createPiSdkSession>>;

      sessionInstance = await createPiSdkSession({
        cwd: workspace,
        arm: "baseline",
        target,
        streamSimpleOverride: (_model, _context, options) => {
          const stream = createAssistantMessageEventStream();
          options?.signal?.addEventListener("abort", () => {
            abortReceived = true;
            const abortedMsg = {
              role: "assistant" as const,
              content: [],
              api: _model.api,
              provider: _model.provider,
              model: _model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "aborted" as const,
              errorMessage: "Request was aborted",
              timestamp: Date.now(),
            };
            stream.push({ type: "error", reason: "aborted", error: abortedMsg });
            stream.end(abortedMsg);
          });

          // Trigger session.abort() once stream execution is actively underway
          setTimeout(() => {
            sessionInstance.session.abort();
          }, 5);

          return stream;
        },
      });

      await sessionInstance.runPrompt("Cancel this");

      expect(abortReceived).toBe(true);
      const lastMsg = sessionInstance.session.messages[sessionInstance.session.messages.length - 1];
      expect((lastMsg as any)?.stopReason).toBe("aborted");
      expect((lastMsg as any)?.errorMessage).toContain("aborted");

      sessionInstance.dispose();
    });
  });

  describe("Sanitization and Pinned HTML Export", () => {
    it("sanitization changes COPIES ONLY, never the live messages used for the next model turn", async () => {
      const workspace = makeTempDir("pi-sanitization");
      const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };

      const SECRET_TOKEN = "SECRET_CANARY_VALUE_99887766";
      const REASONING_TEXT = "I am private thinking that must never leak into evidence";

      const scriptedStream = createScriptedStreamSimple([
        // Turn 1: Model outputs thinking reasoning and a secret marker
        {
          type: "thinking",
          thinking: REASONING_TEXT,
          signature: "encrypted-signature-xyz",
          text: `My secret token is ${SECRET_TOKEN}.`,
        },
      ]);

      const instance = await createPiSdkSession({
        cwd: workspace,
        arm: "baseline",
        target,
        streamSimpleOverride: scriptedStream,
      });

      await instance.runPrompt("Tell me the secret");

      // LIVE SESSION: Verify that live state contains the raw secret and thinking block
      // (because the live conversation must remain faithful for future turns)
      const liveMessages = instance.session.messages;
      const liveAssistant = liveMessages[liveMessages.length - 1] as any;
      const liveHasThinking = liveAssistant.content.some((b: any) => b.type === "thinking");
      expect(liveHasThinking).toBe(true);
      const liveText = liveAssistant.content.find((b: any) => b.type === "text")?.text;
      expect(liveText).toContain(SECRET_TOKEN);

      // Now create a SANITIZED COPY of the session file
      const sessionFile = instance.sessionFile!;
      const sanitizedFile = join(workspace, "session-sanitized.jsonl");

      createSanitizedSessionCopy(sessionFile, sanitizedFile, [
        { label: "CANARY_SECRET", value: SECRET_TOKEN },
      ]);

      // ASSERTION OF RULE R6: LIVE MESSAGES REMAIN UNCHANGED
      const liveAssistantAfter = instance.session.messages[instance.session.messages.length - 1] as any;
      expect(liveAssistantAfter.content.some((b: any) => b.type === "thinking")).toBe(true);
      expect(liveAssistantAfter.content.find((b: any) => b.type === "text")?.text).toContain(SECRET_TOKEN);

      // SANITIZED COPY: Verify thinking is stripped and secret is redacted
      const sanitizedContent = readFileSync(sanitizedFile, "utf8");
      expect(sanitizedContent).not.toContain(SECRET_TOKEN);
      expect(sanitizedContent).toContain("[REDACTED:CANARY_SECRET]");
      expect(sanitizedContent).not.toContain(REASONING_TEXT);
      expect(sanitizedContent).not.toContain("encrypted-signature-xyz");

      // EXPORT TO HTML using pinned exporter
      const htmlPath = join(workspace, "exported.html");
      const hashBeforeExport = sha256File(sanitizedFile);

      await exportSessionFileToHtml(sanitizedFile, htmlPath);

      // Canonical input bytes must NOT be changed by exporter
      const hashAfterExport = sha256File(sanitizedFile);
      expect(hashAfterExport).toBe(hashBeforeExport);

      // Verify exported HTML
      expect(existsSync(htmlPath)).toBe(true);
      const htmlVerification = verifyExportedHtml(htmlPath, {
        disallowedSecrets: [SECRET_TOKEN],
        disallowedReasoningTokens: [REASONING_TEXT, "encrypted-signature-xyz"],
      });
      expect(htmlVerification.valid).toBe(true);
      expect(htmlVerification.violations.length).toBe(0);

      // Also confirm the sanitized token survived in the exported viewer
      const htmlText = readFileSync(htmlPath, "utf8");
      expect(htmlText).not.toContain(SECRET_TOKEN);
      expect(htmlText).not.toContain(REASONING_TEXT);

      instance.dispose();
    });
  });

  describe("Real completion transport blocked (negative test)", () => {
    it("throws RealCompletionTransportBlockedError when an offline test attempts real provider endpoints", async () => {
      // Direct call to Google Gemini endpoint must fail fast before networking
      await expect(
        globalThis.fetch("https://generativelanguage.googleapis.com/v1beta/models"),
      ).rejects.toThrow(RealCompletionTransportBlockedError);

      // Direct call to Anthropic endpoint must fail fast before networking
      await expect(
        globalThis.fetch("https://api.anthropic.com/v1/messages"),
      ).rejects.toThrow(RealCompletionTransportBlockedError);
    });
  });

  describe("Ambient custom glob tool integration", () => {
    it("registers glob via customTools, executes it, and attests ambientCustomTools and activeTools matching allowlist", async () => {
      const workspace = makeTempDir("pi-ambient-glob");
      try {
        mkdirSync(join(workspace, "src"), { recursive: true });
        writeFileSync(join(workspace, "greeting.txt"), "hello");
        writeFileSync(join(workspace, "src/app.ts"), "console.log('hi');");
        writeFileSync(join(workspace, "src/util.ts"), "export const x = 1;");

        const allowedTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "glob"];
        const scriptedStream = createScriptedStreamSimple([
          {
            type: "toolCall",
            toolCalls: [
              {
                id: "call_glob_1",
                name: "glob",
                arguments: { pattern: "**/*.ts" },
              },
            ],
            usage: {
              input: 50, output: 15, cacheRead: 0, cacheWrite: 0, totalTokens: 65,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
          {
            type: "text",
            text: "Glob search completed.",
            usage: {
              input: 65, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 75,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        ]);

        const target: Target = { provider: "google", model: "gemini-3.8-flash", thinking: "low" };
        const sessionInstance = await createPiSdkSession({
          cwd: workspace,
          arm: "baseline",
          target,
          allowedTools,
          ambientTools: buildAmbientTools(["glob"], workspace),
          streamSimpleOverride: scriptedStream,
        });

        // 1. Attestation check
        const attestation = sessionInstance.attest();
        expect(attestation.ambientCustomTools).toEqual(["glob"]);
        expect(attestation.activeTools).toEqual(allowedTools);
        expect(attestation.mcpClientId).toBeNull();

        // 2. Run prompt and verify real execution of glob tool
        await sessionInstance.runPrompt("Find all TypeScript files using glob.");

        const messages = sessionInstance.session.messages;
        const toolResult = messages.find(
          (m) => m.role === "toolResult" && (m as any).toolCallId === "call_glob_1",
        ) as any;
        expect(toolResult).toBeDefined();
        expect(toolResult.toolName).toBe("glob");
        expect(toolResult.content[0].text).toBe("src/app.ts\nsrc/util.ts");

        sessionInstance.dispose();
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  describe("Shared MCP client integration", () => {
    it("records a bad agent endpoint as a native tool error and continues the task", async () => {
      const workspace = makeTempDir("pi-mcp-error");
      const stub = await createMcpStub();
      writeFileSync(join(workspace, "SKILL.md"), "---\nname: test-skill\ndescription: test\n---\nUse tools.\n");
      const instance = await createPiSdkSession({
        cwd: workspace, arm: "treatment", target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
        skillPath: workspace,
        skillToolBundle: { schemaVersion: 1, source: "test", sourceSha256: null, servers: [{ name: "seed", transport: "streamable_http", url: stub.url, description: null }] },
        streamSimpleOverride: createScriptedStreamSimple([
          { type: "toolCall", toolCalls: [{ id: "bad-endpoint", name: "mcp", arguments: { action: "connect", server: "docs", url: "not-a-url" } }] },
          { type: "toolCall", toolCalls: [{ id: "list-after-error", name: "mcp", arguments: { action: "list" } }] },
          { type: "text", text: "Continued after the endpoint failure." },
        ]),
      });
      try {
        await instance.runPrompt("Use relevant tools to complete the task.");
        const results = instance.session.messages.filter((message) => message.role === "toolResult") as any[];
        expect(results.map((result) => result.isError)).toEqual([true, false]);
        expect(results[0].content[0].text).toContain("invalid URL");
        expect(results[1].content[0].text).toContain('"server":"seed"');
        const native = instance.getNativeSessionEntries() as any[];
        expect(native.find((entry) => entry.message?.toolCallId === "bad-endpoint")?.message.isError).toBe(true);
        expect(instance.getBudgetSnapshot().taskLimitReason).toBeNull();
      } finally { instance.dispose(); await stub.close(); }
    });

    it.each([
      { arm: "treatment" as const, seeded: true },
    ])("$arm actual SDK discovers and calls MCP tools (seeded=$seeded)", async ({ arm, seeded }) => {
      const stub = await createMcpStub({
        tools: [{ name: "ask_docs", description: "Ask documentation", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
        responses: { ask_docs: { text: "Scripted documentation answer.", isError: false } },
      });
      const workspace = makeTempDir("pi-shared-mcp");
      const skillDir = join(workspace, "skill");
      if (arm === "treatment") {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), "---\nname: test-skill\ndescription: Consult relevant documentation\n---\nUse the documentation service when helpful.\n");
      }
      const bundle: SkillToolBundle = {
        schemaVersion: 1, source: seeded ? "agents/openai.yaml" : null, sourceSha256: seeded ? "00".repeat(32) : null,
        servers: seeded ? [{ name: "docs", transport: "streamable_http", url: stub.url, description: null }] : [],
      };
      const operations = [
        ...(!seeded ? [{ action: "connect", server: "docs", url: stub.url }] : []),
        { action: "list", server: "docs" },
        { action: "call", server: "docs", tool: "ask_docs", arguments: { query: "example" } },
      ];
      const instance = await createPiSdkSession({
        cwd: workspace, arm, target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
        ...(arm === "treatment" ? { skillPath: skillDir, skillToolBundle: bundle, skillToolBundleSha256: "00".repeat(32) } : {}),
        allowedTools: ["read", "bash", "edit", "write"],
        streamSimpleOverride: createScriptedStreamSimple([
          ...operations.map((arguments_, index) => ({ type: "toolCall" as const, toolCalls: [{ id: `mcp-${index}`, name: "mcp", arguments: arguments_ }] })),
          { type: "text", text: "Finished using documentation." },
        ]),
      });
      try {
        const attestation = instance.attest();
        expect(attestation.activeTools).toEqual(["read", "bash", "edit", "write", "mcp"]);
        expect(attestation.mcpClientId).toBe("shared-mcp-client-v1");
        expect(attestation.seededMcpServers).toEqual(seeded ? ["docs"] : []);
        expect(attestation.loadedSkills).toHaveLength(1);
        expect(stub.requests).toHaveLength(seeded ? 3 : 0);
        await instance.runPrompt("Complete the task using relevant documentation.");
        const results = instance.session.messages.filter((message) => message.role === "toolResult") as any[];
        expect(results).toHaveLength(operations.length);
        expect(results.every((result) => result.toolName === "mcp" && result.isError !== true)).toBe(true);
        expect(results.at(-1).content[0].text).toBe("Scripted documentation answer.");
        const native = JSON.stringify(instance.getNativeSessionEntries());
        expect(native).toContain('"action":"list"');
        expect(native).toContain('"action":"call"');
        if (!seeded) expect(native).toContain('"action":"connect"');
        expect(native).toContain("Scripted documentation answer.");
        expect(stub.requests.map((request) => request.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
      } finally {
        instance.dispose();
        await stub.close();
      }
    });
  });
});
