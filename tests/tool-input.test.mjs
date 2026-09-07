import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createManagedCodeModeExtension } from "../src/index.ts";

function sendCompletion(response, delta, finishReason) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [part, finish] of [
    [delta, null],
    [{}, finishReason],
  ]) {
    response.write(
      `data: ${JSON.stringify({
        id: "completion-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "local-test",
        choices: [{ index: 0, delta: part, finish_reason: finish }],
      })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

// Exercise the real Pi provider, argument validation, extension, and V8 host.
// The loopback fixture supplies model output; no remote model or credential is used.
describe("provider tool input", () => {
  it.each([false, true])("executes Chat Completions input with grammar=%s", async (grammar) => {
    const root = mkdtempSync(join(tmpdir(), "pi-code-mode-input-"));
    const content = 'quotes: "hello"; slash: \\; newline:\nUnicode: 雪';
    const code = `await tools.write({path: "result.txt", content: ${JSON.stringify(content)}});\ntext("written");\nawait yield_control();\ntext("resumed");`;
    const requests = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      requests.push(payload);
      if (!Array.isArray(payload.messages)) {
        response.writeHead(400);
        response.end("Expected Chat Completions messages");
        return;
      }
      const previous = payload.messages.filter((message) => message.role === "tool").at(-1);
      if (requests.length === 1) {
        const call = grammar
          ? { type: "custom", custom: { name: "exec", input: code } }
          : { type: "function", function: { name: "exec", arguments: JSON.stringify({ code }) } };
        sendCompletion(
          response,
          { tool_calls: [{ index: 0, id: "call_exec", ...call }] },
          "tool_calls",
        );
      } else if (requests.length === 2) {
        const cellId = /Call wait with cell_id ([^.]+)\./.exec(previous.content)?.[1];
        sendCompletion(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: "call_wait",
                type: "function",
                function: {
                  name: "wait",
                  arguments: JSON.stringify({ cell_id: cellId, yield_time_ms: 1000 }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        sendCompletion(response, { content: "done" }, "stop");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const managed = createManagedCodeModeExtension({ mode: "pi" });
    let session;
    try {
      const agentDir = join(root, "agent");
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [managed.extension],
      });
      await resourceLoader.reload();
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
      });
      const model = {
        id: "local-test",
        name: "Local test",
        provider: "local-fixture",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        reasoning: false,
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsOpenAIGrammarTools: grammar },
      };
      const otherModel = {
        ...model,
        id: "other-local-test",
        compat: { supportsOpenAIGrammarTools: !grammar },
      };
      modelRuntime.registerProvider(model.provider, {
        baseUrl: model.baseUrl,
        api: model.api,
        apiKey: "local-test-placeholder",
        models: [model, otherModel],
      });
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir,
        model,
        modelRuntime,
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(root),
      }));
      const errors = [];
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      await session.prompt("Write the test file, yield, then resume.");
      expect(errors).toEqual([]);
      expect(requests).toHaveLength(3);
      expect(readFileSync(join(root, "result.txt"), "utf8")).toBe(content);
      for (const payload of requests) {
        expect(payload.tools.map((tool) => (tool.function ?? tool.custom).name)).toEqual([
          "exec",
          "wait",
        ]);
        expect(payload.tools[0].type).toBe(grammar ? "custom" : "function");
        expect(payload.tools[1].type).toBe("function");
        const prompt = payload.messages[0].content;
        expect(prompt.includes("Send raw JavaScript")).toBe(grammar);
        expect(prompt.includes("JSON object containing a code string")).toBe(!grammar);
      }
      const results = session.messages.filter((message) => message.role === "toolResult");
      expect(results.map((result) => result.toolName)).toEqual(["exec", "wait"]);
      expect(results[0].details.status).toBe("waiting");
      expect(results[1].content[0].text).toContain("resumed");
      expect(session.messages.at(-1).content).toEqual([{ type: "text", text: "done" }]);

      // Public model selection must refresh the live definition and prompt together.
      await session.setModel(otherModel);
      await session.prompt("Confirm the new input format.");
      const switched = requests.at(-1);
      expect(switched.tools[0].type).toBe(grammar ? "function" : "custom");
      expect(switched.messages[0].content.includes("Send raw JavaScript")).toBe(!grammar);
      expect(switched.messages[0].content.includes("JSON object containing a code string")).toBe(
        grammar,
      );
    } finally {
      session?.dispose();
      await managed.shutdown();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
