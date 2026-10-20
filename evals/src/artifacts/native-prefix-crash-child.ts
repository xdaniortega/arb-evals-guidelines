import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { createNativeSessionCapture } from "./native-prefix.ts";
import { createPiSdkSession } from "../harnesses/pi/sdk-session.ts";
import { createScriptedStreamSimple } from "../harnesses/pi/scripted-stream.ts";

const [workspace, prefixPath] = process.argv.slice(2);
if (!workspace || !prefixPath || typeof process.send !== "function") process.exit(64);
const secret = "native-prefix-crash-canary";
const first = createScriptedStreamSimple([{ type: "toolCall", toolCalls: [{
  id: "crash_write_1",
  name: "write",
  arguments: { path: "crash.txt", content: secret },
}] }]);
let calls = 0;
const stream = (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => {
  calls += 1;
  if (calls === 1) return first(model, context, options);
  // Reaching the second completion proves the SDK appended both the completed tool-call
  // assistant message and its real tool result. Recorder append fsyncs before returning.
  process.send!({ type: "prefix-fsynced" });
  return createAssistantMessageEventStream();
};
const capture = createNativeSessionCapture({
  path: prefixPath,
  guardedSecrets: [{ label: "CRASH_CANARY", value: secret }],
});
const instance = await createPiSdkSession({
  cwd: workspace,
  arm: "baseline",
  target: { provider: "google", model: "gemini-3.8-flash", thinking: "low" },
  allowedTools: ["write"],
  streamSimpleOverride: stream,
  nativeSessionRecorder: capture,
});
await instance.runPrompt("Write the requested crash fixture, then wait.");
process.exit(65);
