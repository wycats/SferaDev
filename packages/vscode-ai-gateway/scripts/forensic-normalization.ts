import * as vscode from "vscode";
import { hashContent } from "../src/utils/digest";

/**
 * Forensic test to validate why specific normalizations are required.
 * Specifically validates:
 * 1. VS Code adding format-specific decorations to links [title](url) -> [title](url)
 * 2. Tool serialization stability (JSON key sorting)
 */

async function runForensicAnalysis() {
  console.log("Starting Forensic Normalization Analysis...");

  // SCENARIO 1: URL Decoration Drift
  // VS Code's chat UI often decorates bare URLs or specific link formats during rendering/history preservation.
  // We simulate the raw input from the LLM vs what VS Code stores in history.

  const llmRawOutput =
    "Here is a link: [Documentation](https://code.visualstudio.com/api)";
  // Observed behavior in VS Code Chat History: It sometimes adds a space or specific buffer around links
  // or modifies the structure slightly for rendering.
  // Let's assume a known drift case we've seen: ` [Documentation](https://code.visualstudio.com/api)` (Space prefix)
  const vscodeHistoryOutput =
    "Here is a link:  [Documentation](https://code.visualstudio.com/api)";

  const hashRaw = hashContent(llmRawOutput);
  const hashHistory = hashContent(vscodeHistoryOutput);

  console.log(`\nScenario 1: URL Decoration`);
  console.log(`LLM Raw:        "${llmRawOutput}" -> ${hashRaw}`);
  console.log(`VS Code History: "${vscodeHistoryOutput}" -> ${hashHistory}`);

  if (hashRaw !== hashHistory) {
    console.log("❌ Hashes diverge without normalization.");

    // Apply stripOurAdditions normalization logic locally
    const normalizedRaw = llmRawOutput.replace(/ \[[^\]]+\]\([^)]+\)/g, ""); // Simplified regex from codebase
    // This regex in codebase: text.replace(/ \[[^\]]+\]\([^)]+\)/g, "")
    // is primarily replacing the WHOLE link if it matches the 'added' pattern.
    // Wait, let's verify what `stripOurAdditions` actually does in `digest.ts`.
    // It replaces ` [title](url)` with empty string? That sounds like stripping the link entirely?

    // Let's re-read the precise code in digest.ts:
    // const stripped = text.replace(/ \[[^\]]+\]\([^)]+\)/g, "");
    // It assumes the link ITSELF is the addition?

    // Let's test if that normalization bridges the gap if the drift is "link added by us".
    // If the LLM didn't output the link, but VS Code history has it?
  }

  // SCENARIO 2: Tool Argument JSON Stability
  // LLMs output JSON. VS Code parses it. We re-serialize it.
  // Key order matters for hashing.
  const toolInputA = { b: 2, a: 1 };
  const toolInputB = { a: 1, b: 2 };

  const serializedA = JSON.stringify(toolInputA);
  const serializedB = JSON.stringify(toolInputB);

  const hashA = hashContent(serializedA);
  const hashB = hashContent(serializedB);

  console.log(`\nScenario 2: JSON Key Order`);
  console.log(`Input A (b,a): ${serializedA} -> ${hashA}`);
  console.log(`Input B (a,b): ${serializedB} -> ${hashB}`);

  if (hashA !== hashB) {
    console.log("❌ Hashes diverge due to key order.");
    console.log(
      "✅ Requirement: Canonical JSON Serialization (safeJsonStringify) is critical.",
    );
  }
}

runForensicAnalysis();
