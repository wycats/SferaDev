import type { ItemParam } from "openresponses-client";
import type { FormattedToolEntry } from "./tool-history.js";

/**
 * Strategy for rendering tool history into OpenResponses input items.
 */
export interface ToolHistoryStrategy {
  /** Render a single tool call/result pair as input items */
  renderEntry(entry: FormattedToolEntry): ItemParam[];

  /** Render the summary of older tool calls */
  renderSummary(summary: string): ItemParam[];

  /** Strategy identifier for logging */
  readonly name: string;
}

/**
 * Text-embed strategy: Current behavior.
 * Emits tool results as user messages (skips tool call text).
 * Matches current openresponses-chat.ts inline behavior.
 */
export class TextEmbedStrategy implements ToolHistoryStrategy {
  readonly name = "text-embed";

  renderEntry(entry: FormattedToolEntry): ItemParam[] {
    // Skip callText (tool call) - matches current silent drop behavior
    // Emit resultText as user message with "Context (tool result):" prefix
    // Note: entry.resultText already contains "<!-- prior-tool-result: ... -->\n{result}"
    // We need to strip the HTML comment and add the prefix
    const result = entry.resultText.replace(
      /<!-- prior-tool-result: \S+ -->\n/,
      "",
    );

    return [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `Context (tool result):\n${result}` },
        ],
      },
    ];
  }

  renderSummary(summary: string): ItemParam[] {
    if (!summary) return [];
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: summary }],
      },
    ];
  }
}

/**
 * Native strategy: Future behavior when Gateway supports function_call input.
 * Emits function_call + function_call_output items directly.
 */
export class NativeStrategy implements ToolHistoryStrategy {
  readonly name = "native";

  renderEntry(entry: FormattedToolEntry): ItemParam[] {
    // Parse callId, name, and args from the HTML comment format
    // <!-- prior-tool: {name} | id: {callId} | args: {args} -->
    const callMatch = /prior-tool: (\S+) \| id: (\S+) \| args: (.+) -->/.exec(entry.callText);

    if (!callMatch) {
      // Fallback to text-embed if parsing fails
      return new TextEmbedStrategy().renderEntry(entry);
    }

    const [, name, callId, argsStr] = callMatch;

    // Strip the HTML comment from resultText to get raw result
    const result = entry.resultText.replace(
      /<!-- prior-tool-result: \S+ -->\n/,
      "",
    );

    return [
      {
        type: "function_call",
        call_id: callId,
        name,
        arguments: argsStr,
      } as ItemParam,
      {
        type: "function_call_output",
        call_id: callId,
        output: result,
      } as ItemParam,
    ];
  }

  renderSummary(summary: string): ItemParam[] {
    // Native strategy still needs text for summaries (no native equivalent)
    return new TextEmbedStrategy().renderSummary(summary);
  }
}
