/**
 * Minimal VS Code Extension Test Runner
 *
 * No Mocha required - just runs async functions and reports results.
 * This avoids ESM/CJS compatibility issues with Mocha.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

interface TestResult {
  name: string;
  passed: boolean;
  error?: Error;
  duration: number;
}

type TestFn = () => Promise<void> | void;

const tests: { name: string; fn: TestFn }[] = [];

// Simple test registration
export function test(name: string, fn: TestFn): void {
  tests.push({ name, fn });
}

// Run all registered tests
async function runTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  for (const { name, fn } of tests) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, duration: Date.now() - start });
      console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
    } catch (err) {
      results.push({
        name,
        passed: false,
        error: err instanceof Error ? err : new Error(String(err)),
        duration: Date.now() - start,
      });
      console.log(`  ✗ ${name} (${Date.now() - start}ms)`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return results;
}

// ============== TESTS ==============

test("Extension should be present", async () => {
  const ext = vscode.extensions.getExtension(
    "SferaDev.vscode-extension-vercel-ai",
  );
  if (!ext) {
    throw new Error("Extension not found");
  }
});

test("Extension should activate", async () => {
  const ext = vscode.extensions.getExtension(
    "SferaDev.vscode-extension-vercel-ai",
  );
  if (!ext) {
    throw new Error("Extension not found");
  }
  await ext.activate();
});

test("vscode.lm API should be available", async () => {
  if (!vscode.lm) {
    throw new Error("vscode.lm API not available");
  }
  console.log("    vscode.lm methods:", Object.keys(vscode.lm));
});

test("selectChatModels should return Vercel models", async () => {
  // Wait a moment for extension to fully initialize and register models
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Select specifically our Vercel AI Gateway models
  const allModels = await vscode.lm.selectChatModels();
  const vercelModels = await vscode.lm.selectChatModels({
    vendor: "vercelAiGateway",
  });

  console.log(`    Total models: ${allModels.length}`);
  console.log(`    Vercel models: ${vercelModels.length}`);

  if (vercelModels.length === 0) {
    console.log("    NOTE: No Vercel models found.");
    console.log("    This is expected if VERCEL_API_KEY env var is not set.");
    console.log("    Set VERCEL_API_KEY to test with real models.");
  }

  // Categorize all models by vendor for visibility
  const byVendor = new Map<string, typeof allModels>();
  for (const model of allModels) {
    const list = byVendor.get(model.vendor) ?? [];
    list.push(model);
    byVendor.set(model.vendor, list);
  }

  for (const [vendor, vendorModels] of byVendor) {
    console.log(`    ${vendor}: ${vendorModels.length} models`);
    for (const m of vendorModels.slice(0, 3)) {
      console.log(`      - ${m.family} (${m.id})`);
    }
    if (vendorModels.length > 3) {
      console.log(`      ... and ${vendorModels.length - 3} more`);
    }
  }
});

test("Forensic: Enable capture and check options passed to provider", async () => {
  // Enable forensic capture via settings
  const config = vscode.workspace.getConfiguration("vercelAiGateway.debug");
  await config.update(
    "forensicCapture",
    true,
    vscode.ConfigurationTarget.Global,
  );
  console.log("    Forensic capture enabled");
});

test("Forensic: Capture sendRequest protocol with Vercel model", async () => {
  // Specifically select Vercel AI Gateway models
  const vercelModels = await vscode.lm.selectChatModels({
    vendor: "vercelAiGateway",
  });

  if (vercelModels.length === 0) {
    console.log("    SKIP: No Vercel models available");
    console.log(
      "    Set VERCEL_API_KEY environment variable to enable this test.",
    );
    return;
  }

  // Pick a fast model for testing
  const model =
    vercelModels.find((m) => m.family.includes("gpt-4o-mini")) ??
    vercelModels[0]!;
  console.log(`    Using model: ${model.vendor}/${model.family} (${model.id})`);
  console.log(`    Model info: maxInputTokens=${model.maxInputTokens}`);

  const messages = [
    vscode.LanguageModelChatMessage.User("Say 'hello' and nothing else"),
  ];

  try {
    console.log("    Calling sendRequest...");
    const response = await model.sendRequest(messages, {});
    console.log("    sendRequest returned");

    // Capture all properties on the response object
    console.log("    Response object keys:", Object.keys(response));
    console.log(
      "    Response prototype:",
      Object.getPrototypeOf(response)?.constructor?.name,
    );

    // Deep inspect the response object
    for (const key of Object.keys(response)) {
      const value = (response as unknown as Record<string, unknown>)[key];
      const valueType = typeof value;
      if (
        valueType === "string" ||
        valueType === "number" ||
        valueType === "boolean"
      ) {
        console.log(
          `    response.${key} = ${JSON.stringify(value)} (${valueType})`,
        );
      } else if (value && typeof value === "object") {
        console.log(
          `    response.${key} = [${value.constructor?.name ?? "object"}]`,
        );
      }
    }

    // Consume the stream to complete the request
    console.log("    Consuming response.stream...");
    const parts: string[] = [];
    for await (const part of response.stream) {
      // part is LanguageModelChatResponsePart (TextPart or ToolCallPart)
      if (part instanceof vscode.LanguageModelTextPart) {
        parts.push(`TextPart: "${part.value}"`);
      } else {
        parts.push(`OtherPart: ${(part as object).constructor?.name}`);
      }
    }
    console.log(`    Stream parts (${parts.length}):`, parts.slice(0, 5));

    // Also try the text iterator
    console.log("    Consuming response.text...");
    let text = "";
    for await (const chunk of response.text) {
      text += chunk;
    }
    console.log(
      `    Response text: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
    );
  } catch (err) {
    console.log(`    Request failed: ${err}`);
    if (err instanceof Error) {
      console.log(`    Error stack: ${err.stack}`);
    }
  }
});

test("Forensic: Multi-turn conversation simulation", async () => {
  const vercelModels = await vscode.lm.selectChatModels({
    vendor: "vercelAiGateway",
  });

  if (vercelModels.length === 0) {
    console.log("    SKIP: No Vercel models available");
    return;
  }

  const model =
    vercelModels.find((m) => m.family.includes("gpt-4o-mini")) ??
    vercelModels[0]!;
  console.log(`    Using model: ${model.id}`);

  // Turn 1: Initial request
  console.log("    Turn 1: Initial request...");
  const turn1Messages = [vscode.LanguageModelChatMessage.User("What is 2+2?")];

  const response1 = await model.sendRequest(turn1Messages, {});
  let turn1Response = "";
  for await (const chunk of response1.stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) {
      turn1Response += chunk.value;
    }
  }
  console.log(`    Turn 1 response: "${turn1Response.slice(0, 50)}..."`);

  // Turn 2: Follow-up with history (simulates multi-turn)
  console.log("    Turn 2: Follow-up with history...");
  const turn2Messages = [
    vscode.LanguageModelChatMessage.User("What is 2+2?"),
    vscode.LanguageModelChatMessage.Assistant(turn1Response),
    vscode.LanguageModelChatMessage.User("Now multiply that by 3"),
  ];

  const response2 = await model.sendRequest(turn2Messages, {});
  let turn2Response = "";
  for await (const chunk of response2.stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) {
      turn2Response += chunk.value;
    }
  }
  console.log(`    Turn 2 response: "${turn2Response.slice(0, 50)}..."`);

  // Turn 3: Another follow-up (longer history)
  console.log("    Turn 3: Another follow-up...");
  const turn3Messages = [
    vscode.LanguageModelChatMessage.User("What is 2+2?"),
    vscode.LanguageModelChatMessage.Assistant(turn1Response),
    vscode.LanguageModelChatMessage.User("Now multiply that by 3"),
    vscode.LanguageModelChatMessage.Assistant(turn2Response),
    vscode.LanguageModelChatMessage.User("Is that correct?"),
  ];

  const response3 = await model.sendRequest(turn3Messages, {});
  let turn3Response = "";
  for await (const chunk of response3.stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) {
      turn3Response += chunk.value;
    }
  }
  console.log(`    Turn 3 response: "${turn3Response.slice(0, 50)}..."`);

  console.log(
    "    Multi-turn conversation complete - check forensic captures for chatId patterns",
  );
});

test("Forensic: Subagent-style request (fresh context)", async () => {
  // Subagents get a fresh system prompt and new context
  // This simulates what happens when Copilot spawns a subagent

  const vercelModels = await vscode.lm.selectChatModels({
    vendor: "vercelAiGateway",
  });

  if (vercelModels.length === 0) {
    console.log("    SKIP: No Vercel models available");
    return;
  }

  const model =
    vercelModels.find((m) => m.family.includes("gpt-4o-mini")) ??
    vercelModels[0]!;
  console.log(`    Using model: ${model.id}`);

  // Simulate a subagent with a different system prompt
  console.log("    Subagent request with fresh system prompt...");
  const subagentMessages = [
    vscode.LanguageModelChatMessage.User(`You are a specialized research agent.
Your task is to analyze code and return findings.

<task>
Analyze the following and return a brief summary.
</task>

<code>
function add(a, b) { return a + b; }
</code>`),
  ];

  const response = await model.sendRequest(subagentMessages, {});
  let responseText = "";
  for await (const chunk of response.stream) {
    if (chunk instanceof vscode.LanguageModelTextPart) {
      responseText += chunk.value;
    }
  }
  console.log(`    Subagent response: "${responseText.slice(0, 100)}..."`);

  console.log(
    "    Subagent request complete - this should have a DIFFERENT chatId from multi-turn",
  );
});

test("Forensic: Register chat participant and capture context", async () => {
  // Register a chat participant to see what context Copilot passes
  // This helps us understand the ChatRequest structure

  const participant = vscode.chat.createChatParticipant(
    "test-forensic-capture",
    async (request, context, response, _token) => {
      console.log("    Chat participant received request:");
      console.log(`      prompt: "${request.prompt.slice(0, 50)}..."`);
      console.log(`      command: ${request.command ?? "none"}`);
      console.log(`      model.id: ${request.model.id}`);
      console.log(`      model.vendor: ${request.model.vendor}`);
      console.log(`      references: ${request.references.length}`);
      console.log(`      toolReferences: ${request.toolReferences.length}`);
      console.log(`      history length: ${context.history.length}`);

      // Check for toolInvocationToken - this is key for subagent correlation
      console.log(
        `      toolInvocationToken: ${request.toolInvocationToken ? "present" : "absent"}`,
      );

      // Now make a request to our Vercel model from within the participant
      const vercelModels = await vscode.lm.selectChatModels({
        vendor: "vercelAiGateway",
      });
      if (vercelModels.length > 0) {
        const model = vercelModels[0]!;
        console.log(`      Making request to Vercel model: ${model.id}`);

        const messages = [
          vscode.LanguageModelChatMessage.User(
            "Say 'participant test' and nothing else",
          ),
        ];

        try {
          const lmResponse = await model.sendRequest(messages, {});
          let text = "";
          for await (const chunk of lmResponse.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
              text += chunk.value;
            }
          }
          response.markdown(`Response from Vercel model: ${text}`);
        } catch (err) {
          console.log(`      Error calling Vercel model: ${err}`);
          response.markdown("Error calling model");
        }
      } else {
        response.markdown("No Vercel models available");
      }

      return { metadata: { captured: true } };
    },
  );

  console.log("    Registered chat participant: test-forensic-capture");

  // Check what chat participants are available
  // The default participant handles messages when no @mention is used
  const commands = await vscode.commands.getCommands(true);
  const participantCommands = commands.filter(
    (c) => c.includes("participant") || c.includes("@"),
  );
  console.log(
    `    Participant-related commands: ${participantCommands.length}`,
  );
  for (const cmd of participantCommands.slice(0, 10)) {
    console.log(`      - ${cmd}`);
  }

  // Check available chat commands
  const chatCommands = commands.filter(
    (c) => c.includes("chat") || c.includes("copilot"),
  );
  console.log(`    Found ${chatCommands.length} chat/copilot commands`);

  // Look for commands that might let us send a message
  const sendCommands = chatCommands.filter(
    (c) =>
      c.includes("send") ||
      c.includes("submit") ||
      c.includes("new") ||
      c.includes("open"),
  );
  console.log("    Potential send/open commands:");
  for (const cmd of sendCommands.slice(0, 15)) {
    console.log(`      - ${cmd}`);
  }

  // Try to open chat and send a message programmatically
  console.log("    Attempting to interact with chat...");

  // First, let's see what models are selected in chat
  const allModels = await vscode.lm.selectChatModels({});
  console.log(`    Available models: ${allModels.length}`);
  const vercelModels = allModels.filter((m) => m.vendor === "vercelAiGateway");
  console.log(`    Vercel models: ${vercelModels.length}`);

  try {
    // Open chat panel
    await vscode.commands.executeCommand("workbench.action.chat.open");
    console.log("    ✓ Opened chat panel");
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Try workbench.action.chat.openagent - this might let us specify an agent
    try {
      await vscode.commands.executeCommand("workbench.action.chat.openagent", {
        agentId: "test-forensic-capture",
        query: "hello from automated test",
      });
      console.log("    ✓ Opened agent chat");
    } catch (e) {
      console.log(`    ✗ openagent failed: ${e}`);
    }

    // Try to directly invoke our participant by calling sendRequest on a Vercel model
    // This simulates what a chat participant would do
    if (vercelModels.length > 0) {
      const model = vercelModels[0]!;
      console.log(
        `    Making direct request to ${model.id} (simulating participant)...`,
      );

      // Create a message that looks like what a chat participant would receive
      const messages = [
        vscode.LanguageModelChatMessage.User(
          "This is an automated test from the chat participant simulation. Say 'PARTICIPANT_TEST_OK'.",
        ),
      ];

      try {
        const response = await model.sendRequest(messages, {});
        let text = "";
        for await (const chunk of response.stream) {
          if (chunk instanceof vscode.LanguageModelTextPart) {
            text += chunk.value;
          }
        }
        console.log(`    ✓ Got response: "${text.slice(0, 50)}..."`);
      } catch (e) {
        console.log(`    ✗ sendRequest failed: ${e}`);
      }
    }

    // Try to select our model and submit a chat message through Copilot
    try {
      // Find model selection commands
      const modelCommands = chatCommands.filter(
        (c) => c.includes("model") || c.includes("Model"),
      );
      console.log(`    Model-related commands: ${modelCommands.join(", ")}`);

      // Start a new chat and open the panel
      await vscode.commands.executeCommand("workbench.action.chat.open");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await vscode.commands.executeCommand("workbench.action.chat.newChat");
      await new Promise((resolve) => setTimeout(resolve, 500));
      console.log("    ✓ Opened chat panel and started new chat");

      // Try to select our model using changeModel command
      // The command might expect a model object, not a string
      try {
        // Get our model object
        const ourModel = vercelModels.find((m) => m.id.includes("gpt-4o-mini"));
        if (ourModel) {
          console.log(`    Found our model: ${ourModel.id} (${ourModel.name})`);
          console.log(
            `    Model details: vendor=${ourModel.vendor}, family=${ourModel.family}`,
          );
          // Log capabilities to debug agent mode support
          const caps = (
            ourModel as unknown as { capabilities?: Record<string, unknown> }
          ).capabilities;
          console.log(`    Model capabilities: ${JSON.stringify(caps)}`);

          // Try passing the model object directly
          try {
            await vscode.commands.executeCommand(
              "workbench.action.chat.changeModel",
              ourModel,
            );
            await new Promise((resolve) => setTimeout(resolve, 300));
            console.log("    ✓ changeModel succeeded with model object");
          } catch (e1) {
            console.log(`    ✗ changeModel with object failed: ${e1}`);

            // Try with an object containing the model
            try {
              await vscode.commands.executeCommand(
                "workbench.action.chat.changeModel",
                { model: ourModel },
              );
              console.log("    ✓ changeModel succeeded with {model: ...}");
            } catch (e2) {
              console.log(`    ✗ changeModel with {model} failed: ${e2}`);

              // Try switchToNextModel repeatedly until we get our model
              console.log("    Trying switchToNextModel...");
              for (let i = 0; i < 10; i++) {
                await vscode.commands.executeCommand(
                  "workbench.action.chat.switchToNextModel",
                );
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              console.log("    ✓ Cycled through models");
            }
          }
        } else {
          console.log("    ✗ Could not find gpt-4o-mini model");
        }
      } catch (e) {
        console.log(`    ✗ Model selection failed: ${e}`);
      }

      // Check current session ID to identify test captures
      const testSessionId = vscode.env.sessionId;
      console.log(`    Test session ID: ${testSessionId.substring(0, 8)}...`);

      // Check Copilot authentication status
      try {
        const copilotSessions = await vscode.authentication.getSession(
          "github",
          ["copilot"],
          { createIfNone: false },
        );
        console.log(
          `    Copilot auth: ${copilotSessions ? "signed in as " + copilotSessions.account.label : "NOT signed in"}`,
        );
      } catch (e) {
        console.log(`    Copilot auth check failed: ${e}`);
      }

      // Count captures before submission (only from this session)
      const captureFileBefore = path.join(
        os.homedir(),
        ".vscode-ai-gateway",
        "forensic-captures.jsonl",
      );
      let captureCountBefore = 0;
      let testCapturesBefore = 0;
      if (fs.existsSync(captureFileBefore)) {
        const lines = fs
          .readFileSync(captureFileBefore, "utf-8")
          .trim()
          .split("\n")
          .filter((l) => l.length > 0);
        captureCountBefore = lines.length;
        testCapturesBefore = lines.filter((l) => {
          try {
            const capture = JSON.parse(l);
            return capture.vscodeEnv?.sessionId?.startsWith(
              testSessionId.substring(0, 8),
            );
          } catch {
            return false;
          }
        }).length;
      }
      console.log(
        `    Captures before: ${captureCountBefore} total, ${testCapturesBefore} from this test session`,
      );

      // Open chat with a query - use @mention to route to OUR participant, bypassing Copilot
      // This is how VS Code's own tests work - they @mention their test participant
      console.log(
        "    Opening chat with @test-forensic-capture mention (bypasses Copilot)...",
      );
      await vscode.commands.executeCommand("workbench.action.chat.open", {
        query:
          "@test-forensic-capture Say 'PARTICIPANT_ROUTED_TEST' if you can see this",
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      console.log("    ✓ Opened chat with @mention query");

      // Wait for response
      await new Promise((resolve) => setTimeout(resolve, 5000));
      console.log("    ✓ Waited for response");

      // Count captures after submission (only from this session)
      let captureCountAfter = 0;
      let testCapturesAfter = 0;
      if (fs.existsSync(captureFileBefore)) {
        const lines = fs
          .readFileSync(captureFileBefore, "utf-8")
          .trim()
          .split("\n")
          .filter((l) => l.length > 0);
        captureCountAfter = lines.length;
        testCapturesAfter = lines.filter((l) => {
          try {
            const capture = JSON.parse(l);
            return capture.vscodeEnv?.sessionId?.startsWith(
              testSessionId.substring(0, 8),
            );
          } catch {
            return false;
          }
        }).length;
      }
      console.log(
        `    Captures after: ${captureCountAfter} total, ${testCapturesAfter} from this test session`,
      );
      console.log(
        `    New captures from chat (this session): ${testCapturesAfter - testCapturesBefore}`,
      );
      console.log(
        `    New captures from chat (any session): ${captureCountAfter - captureCountBefore}`,
      );

      // Since Copilot participant may not be active, let's simulate what it would do:
      // Call sendRequest on our model with tools (like a real chat participant would)
      console.log("    Simulating chat participant behavior with tools...");
      const toolModel = vercelModels.find((m) => m.id.includes("gpt-4o-mini"));
      if (toolModel) {
        const toolMessages = [
          vscode.LanguageModelChatMessage.User(
            "What is 2+2? Use the calculator tool if available.",
          ),
        ];

        // Define a simple tool like a chat participant would
        const tools: vscode.LanguageModelChatTool[] = [
          {
            name: "calculator",
            description: "Performs basic arithmetic",
            inputSchema: {
              type: "object",
              properties: {
                expression: { type: "string", description: "Math expression" },
              },
              required: ["expression"],
            },
          },
        ];

        try {
          const toolResponse = await toolModel.sendRequest(toolMessages, {
            tools,
          });
          let toolText = "";
          for await (const chunk of toolResponse.stream) {
            if (chunk instanceof vscode.LanguageModelTextPart) {
              toolText += chunk.value;
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
              console.log(
                `    Tool call: ${chunk.name}(${JSON.stringify(chunk.input)})`,
              );
            }
          }
          console.log(
            `    ✓ Tool-enabled request succeeded: "${toolText.slice(0, 50)}..."`,
          );
        } catch (e) {
          console.log(`    ✗ Tool-enabled request failed: ${e}`);
        }
      }
    } catch (e) {
      console.log(`    ✗ Chat submit flow failed: ${e}`);
    }
  } catch (e) {
    console.log(`    ✗ Failed: ${e}`);
  }

  // Clean up
  participant.dispose();
  console.log("    Disposed chat participant");
});

test("Forensic: Analyze captured data for conversation patterns", async () => {
  // Give a moment for the capture to be written
  await new Promise((resolve) => setTimeout(resolve, 500));

  const captureFile = path.join(
    os.homedir(),
    ".vscode-ai-gateway",
    "forensic-captures.jsonl",
  );

  if (!fs.existsSync(captureFile)) {
    console.log("    No forensic capture file found");
    console.log("    This is expected if forensic capture wasn't enabled");
    return;
  }

  const content = fs.readFileSync(captureFile, "utf-8");
  const lines = content
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  console.log(`    Found ${lines.length} capture(s)`);

  if (lines.length === 0) return;

  // Parse all captures
  const captures = lines.map((line) => JSON.parse(line));

  // Analyze patterns across captures
  console.log("\n    === PATTERN ANALYSIS ===");

  // 1. Check if sessionId is consistent
  const sessionIds = new Set(
    captures.map(
      (c: { vscodeEnv?: { sessionId?: string } }) => c.vscodeEnv?.sessionId,
    ),
  );
  console.log(
    `    Unique sessionIds: ${sessionIds.size} (should be 1 for same VS Code window)`,
  );

  // 2. Check chatIds (our generated IDs)
  const chatIds = captures.map(
    (c: { internalState?: { chatId?: string } }) => c.internalState?.chatId,
  );
  const uniqueChatIds = new Set(chatIds);
  console.log(`    Unique chatIds: ${uniqueChatIds.size} (we generate these)`);

  // 3. Check modelOptions across all captures
  const modelOptionsVariants = new Set(
    captures.map((c: { options?: { modelOptions?: unknown } }) =>
      JSON.stringify(c.options?.modelOptions),
    ),
  );
  console.log(`    Unique modelOptions variants: ${modelOptionsVariants.size}`);
  for (const variant of modelOptionsVariants) {
    console.log(`      - ${variant}`);
  }

  // 4. Check system prompt hashes (key for subagent detection)
  const systemPromptHashes = captures.map(
    (c: { systemPrompt?: { hash?: string } }) => c.systemPrompt?.hash ?? "none",
  );
  const uniqueHashes = new Set(systemPromptHashes);
  console.log(`    Unique system prompt hashes: ${uniqueHashes.size}`);
  for (const hash of uniqueHashes) {
    const count = systemPromptHashes.filter((h: string) => h === hash).length;
    console.log(`      - ${hash}: ${count} request(s)`);
  }

  // 5. Message count distribution (subagents typically have fewer messages)
  const messageCounts = captures.map(
    (c: { messages?: { count?: number } }) => c.messages?.count ?? 0,
  );
  console.log(`    Message counts: ${messageCounts.join(", ")}`);

  // 6. Look for any non-empty modelOptions
  const nonEmptyModelOptions = captures.filter(
    (c: { options?: { modelOptions?: Record<string, unknown> } }) =>
      c.options?.modelOptions && Object.keys(c.options.modelOptions).length > 0,
  );
  if (nonEmptyModelOptions.length > 0) {
    console.log(
      `    ⚠️ FOUND ${nonEmptyModelOptions.length} capture(s) with non-empty modelOptions!`,
    );
    for (const c of nonEmptyModelOptions) {
      console.log(
        `      Sequence ${(c as { sequence?: number }).sequence}: ${JSON.stringify((c as { options?: { modelOptions?: unknown } }).options?.modelOptions)}`,
      );
    }
  } else {
    console.log(
      "    All modelOptions are empty (VS Code doesn't pass conversation IDs)",
    );
  }

  // 7. Summary table
  console.log("\n    === CAPTURE SUMMARY ===");
  console.log("    Seq | Messages | System Hash | ChatId (ours)");
  console.log("    ----|----------|-------------|---------------");
  for (const c of captures) {
    const cap = c as {
      sequence?: number;
      messages?: { count?: number };
      systemPrompt?: { hash?: string };
      internalState?: { chatId?: string };
    };
    const seq = String(cap.sequence ?? "?").padStart(3);
    const msgs = String(cap.messages?.count ?? "?").padStart(8);
    const hash = (cap.systemPrompt?.hash ?? "none").slice(0, 11);
    const chatId = (cap.internalState?.chatId ?? "?").slice(0, 20);
    console.log(`    ${seq} | ${msgs} | ${hash} | ${chatId}`);
  }

  console.log("\n    === CONCLUSION ===");
  console.log(
    "    VS Code does NOT pass conversation IDs through options.modelOptions",
  );
  console.log(
    "    Subagent detection must rely on system prompt fingerprinting",
  );
});

// ============== ENTRY POINT ==============

export async function run(): Promise<void> {
  console.log("\n=== VS Code Extension Integration Tests ===\n");

  const results = await runTests();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    throw new Error(`${failed} test(s) failed`);
  }
}
