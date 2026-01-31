/**
 * Stream Adapter
 *
 * Converts OpenResponses streaming events to VS Code LanguageModel response parts.
 *
 * This module handles ALL 24 OpenResponses streaming event types explicitly.
 * No event is ignored - each is mapped to an appropriate VS Code representation.
 *
 * Event Categories:
 * 1. Lifecycle events (created, queued, in_progress, completed, failed, incomplete)
 * 2. Output item events (added, done)
 * 3. Content part events (added, done)
 * 4. Text events (delta, done, annotation)
 * 5. Refusal events (delta, done)
 * 6. Reasoning events (delta, done, summary delta/done, summary part added/done)
 * 7. Function call events (arguments delta, arguments done)
 * 8. Error events
 */

import type {
  Error as ResponseError,
  ErrorPayload,
  ErrorStreamingEvent,
  IncompleteDetails,
  ItemField,
  ResponseCompletedStreamingEvent,
  ResponseContentPartAddedStreamingEvent,
  ResponseContentPartDoneStreamingEvent,
  ResponseCreatedStreamingEvent,
  ResponseFailedStreamingEvent,
  ResponseFunctionCallArgumentsDeltaStreamingEvent,
  ResponseFunctionCallArgumentsDoneStreamingEvent,
  ResponseIncompleteStreamingEvent,
  ResponseInProgressStreamingEvent,
  ResponseOutputItemAddedStreamingEvent,
  ResponseOutputItemDoneStreamingEvent,
  ResponseOutputTextAnnotationAddedStreamingEvent,
  ResponseOutputTextDeltaStreamingEvent,
  ResponseOutputTextDoneStreamingEvent,
  ResponseQueuedStreamingEvent,
  ResponseReasoningDeltaStreamingEvent,
  ResponseReasoningDoneStreamingEvent,
  ResponseReasoningSummaryDeltaStreamingEvent,
  ResponseReasoningSummaryDoneStreamingEvent,
  ResponseReasoningSummaryPartAddedStreamingEvent,
  ResponseReasoningSummaryPartDoneStreamingEvent,
  ResponseRefusalDeltaStreamingEvent,
  ResponseRefusalDoneStreamingEvent,
  ResponseResource,
  StreamingEvent,
  UrlCitationBody,
  Usage,
} from "openresponses-client";
import {
  type LanguageModelResponsePart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
} from "vscode";
import { logger } from "../logger.js";

/**
 * Result of adapting a single streaming event
 */
export interface AdaptedEvent {
  /** VS Code response parts to report (can be multiple per event) */
  parts: LanguageModelResponsePart[];
  /** Usage data from completion event (if any) */
  usage?: Usage | undefined;
  /** Whether this is a terminal event (completed, failed, error, incomplete) */
  done: boolean;
  /** Error message if this is an error/failed event */
  error?: string | undefined;
  /** The finish reason extracted from terminal events */
  finishReason?:
    | "stop"
    | "length"
    | "tool-calls"
    | "content-filter"
    | "error"
    | "other";
  /** Response ID from the API */
  responseId?: string | undefined;
  /** Model that generated the response */
  model?: string | undefined;
}

/**
 * State for tracking function calls during streaming
 */
interface FunctionCallState {
  callId: string;
  name: string;
  argumentsBuffer: string;
  itemId: string;
}

/**
 * State for tracking text content across deltas
 */
interface TextContentState {
  itemId: string;
  contentIndex: number;
  buffer: string;
}

/**
 * State for tracking refusal content
 */
interface RefusalState {
  itemId: string;
  contentIndex: number;
  buffer: string;
}

/**
 * State for tracking reasoning content (for models that expose thinking)
 */
interface ReasoningState {
  itemId: string;
  contentIndex: number;
  buffer: string;
}

/**
 * State for tracking reasoning summaries
 */
interface ReasoningSummaryState {
  itemId: string;
  summaryIndex: number;
  buffer: string;
}

interface FunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

interface FunctionCallItemFallback {
  id?: string;
  call_id: string;
  name: string;
  arguments?: string;
}

type ToolCallArguments = Record<string, unknown>;

/**
 * Stream adapter that maintains state across events and produces VS Code parts.
 *
 * Usage:
 * ```ts
 * const adapter = new StreamAdapter();
 * for await (const event of openResponsesStream) {
 *   const result = adapter.adapt(event);
 *   for (const part of result.parts) {
 *     stream.report(part);
 *   }
 *   if (result.done) {
 *     // Handle completion, usage, etc.
 *   }
 * }
 * ```
 */
export class StreamAdapter {
  /** Function calls being assembled from streaming deltas */
  private functionCalls = new Map<string, FunctionCallState>();

  /** Tool calls already emitted to VS Code */
  private emittedToolCalls = new Set<string>();

  /** Text content being assembled (for reference, not needed for delta streaming) */
  private textContent = new Map<string, TextContentState>();

  /** Refusal content being assembled */
  private refusalContent = new Map<string, RefusalState>();

  /** Reasoning content being assembled */
  private reasoningContent = new Map<string, ReasoningState>();

  /** Reasoning summaries being assembled */
  private reasoningSummaries = new Map<string, ReasoningSummaryState>();

  /** Response metadata captured from lifecycle events */
  private responseId: string | undefined;
  private model: string | undefined;

  /**
   * Adapt a single OpenResponses streaming event to VS Code format.
   *
   * This method handles ALL event types explicitly. Each event type has
   * its own handler to ensure high-fidelity translation.
   */
  adapt(event: StreamingEvent): AdaptedEvent {
    switch (event.type) {
      // ===== Lifecycle Events =====
      case "response.created":
        return this.handleResponseCreated(event);

      case "response.queued":
        return this.handleResponseQueued(event);

      case "response.in_progress":
        return this.handleResponseInProgress(event);

      case "response.completed":
        return this.handleResponseCompleted(event);

      case "response.failed":
        return this.handleResponseFailed(event);

      case "response.incomplete":
        return this.handleResponseIncomplete(event);

      // ===== Output Item Events =====
      case "response.output_item.added":
        return this.handleOutputItemAdded(event);

      case "response.output_item.done":
        return this.handleOutputItemDone(event);

      // ===== Content Part Events =====
      case "response.content_part.added":
        return this.handleContentPartAdded(event);

      case "response.content_part.done":
        return this.handleContentPartDone(event);

      // ===== Text Events =====
      case "response.output_text.delta":
        return this.handleTextDelta(event);

      case "response.output_text.done":
        return this.handleTextDone(event);

      case "response.output_text.annotation.added":
        return this.handleAnnotationAdded(event);

      // ===== Refusal Events =====
      case "response.refusal.delta":
        return this.handleRefusalDelta(event);

      case "response.refusal.done":
        return this.handleRefusalDone(event);

      // ===== Reasoning Events (for thinking models) =====
      case "response.reasoning.delta":
        return this.handleReasoningDelta(event);

      case "response.reasoning.done":
        return this.handleReasoningDone(event);

      case "response.reasoning_summary_text.delta":
        return this.handleReasoningSummaryDelta(event);

      case "response.reasoning_summary_text.done":
        return this.handleReasoningSummaryDone(event);

      case "response.reasoning_summary_part.added":
        return this.handleReasoningSummaryPartAdded(event);

      case "response.reasoning_summary_part.done":
        return this.handleReasoningSummaryPartDone(event);

      // ===== Function Call Events =====
      case "response.function_call_arguments.delta":
        return this.handleFunctionCallArgsDelta(event);

      case "response.function_call_arguments.done":
        return this.handleFunctionCallArgsDone(event);

      // ===== Error Events =====
      case "error":
        return this.handleError(event);

      default: {
        // TypeScript exhaustiveness check - this should never happen
        // If we get here, a new event type was added to OpenResponses
        const _exhaustive: never = event;
        void _exhaustive;
        console.warn(
          `Unhandled streaming event type: ${(event as StreamingEvent).type}`,
        );
        return { parts: [], done: false };
      }
    }
  }

  // ===== Lifecycle Event Handlers =====

  private handleResponseCreated(
    event: ResponseCreatedStreamingEvent,
  ): AdaptedEvent {
    // Capture response metadata for later use
    const response = event.response as ResponseResource | undefined;
    this.responseId = response?.id;
    this.model = response?.model;

    return {
      parts: [],
      done: false,
      responseId: this.responseId,
      model: this.model,
    };
  }

  private handleResponseQueued(
    _event: ResponseQueuedStreamingEvent,
  ): AdaptedEvent {
    void _event;
    // Response is queued but not yet processing
    // This is useful for monitoring but doesn't produce output
    return { parts: [], done: false };
  }

  private handleResponseInProgress(
    _event: ResponseInProgressStreamingEvent,
  ): AdaptedEvent {
    void _event;
    // Response is being processed
    // This is useful for monitoring but doesn't produce output
    return { parts: [], done: false };
  }

  private handleResponseCompleted(
    event: ResponseCompletedStreamingEvent,
  ): AdaptedEvent {
    const response = event.response as ResponseResource;
    const usage = response.usage as Usage;

    // Determine finish reason from output
    let finishReason: AdaptedEvent["finishReason"] = "stop";

    // Collect any tool calls from the response output that weren't emitted during streaming
    const parts: LanguageModelResponsePart[] = [];
    const outputItems = response.output;
    const typeCounts = new Map<string, number>();
    for (const item of outputItems) {
      const t = item.type;
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
    const topTypes = Array.from(typeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([t, c]) => `${t}:${c.toString()}`)
      .join(", ");
    logger.debug(
      `[OpenResponses] response.completed output summary (id=${response.id}, len=${outputItems.length.toString()}, types=${topTypes})`,
    );

    let functionCallsFound = 0;
    let functionCallsEmitted = 0;
    let functionCallsSkippedDuplicate = 0;

    for (const item of outputItems) {
      if (item.type === "function_call") {
        functionCallsFound++;
        finishReason = "tool-calls";

        // Extract tool call details
        const functionCall = item as FunctionCallItem;
        const callId = functionCall.call_id;
        const name = functionCall.name;
        const argsStr = functionCall.arguments;

        logger.debug(
          `[OpenResponses] Found function_call in output: name=${name}, callId=${callId}, argsLen=${argsStr.length.toString()}`,
        );

        // Only emit if this tool call wasn't already emitted via streaming events
        if (callId && name && !this.emittedToolCalls.has(callId)) {
          let parsedArgs: ToolCallArguments = {};
          try {
            parsedArgs = JSON.parse(argsStr) as ToolCallArguments;
          } catch (e) {
            logger.warn(
              `[OpenResponses] Failed to parse function_call arguments: ${e instanceof Error ? e.message : String(e)}`,
            );
          }

          logger.info(
            `[OpenResponses] Emitting tool call from completion payload: ${name} (callId: ${callId})`,
          );
          parts.push(new LanguageModelToolCallPart(callId, name, parsedArgs));
          this.emittedToolCalls.add(callId);
          functionCallsEmitted++;
        } else if (this.emittedToolCalls.has(callId)) {
          functionCallsSkippedDuplicate++;
          logger.debug(
            `[OpenResponses] Skipping duplicate tool call: ${name} (callId: ${callId})`,
          );
        } else {
          logger.warn(
            `[OpenResponses] Skipping tool call with missing callId or name: callId=${callId}, name=${name}`,
          );
        }
      }
    }

    if (functionCallsFound > 0) {
      logger.info(
        `[OpenResponses] Completion output tool calls: found=${functionCallsFound.toString()}, emitted=${functionCallsEmitted.toString()}, skippedDupe=${functionCallsSkippedDuplicate.toString()}`,
      );
    }

    return {
      parts,
      usage,
      done: true,
      finishReason,
      responseId: response.id,
      model: response.model,
    };
  }

  private handleResponseFailed(
    event: ResponseFailedStreamingEvent,
  ): AdaptedEvent {
    const response = event.response as ResponseResource | undefined;
    const responseError = response?.error as ResponseError | null | undefined;
    const errorMessage = responseError?.message ?? "Response generation failed";

    return {
      parts: [new LanguageModelTextPart(`\n\n**Error:** ${errorMessage}\n\n`)],
      done: true,
      error: errorMessage,
      finishReason: "error",
      responseId: response?.id,
    };
  }

  private handleResponseIncomplete(
    event: ResponseIncompleteStreamingEvent,
  ): AdaptedEvent {
    const response = event.response as ResponseResource | undefined;
    const incompleteDetails = response?.incomplete_details as
      | IncompleteDetails
      | null
      | undefined;
    const reason = incompleteDetails?.reason ?? "unknown";

    // Map incomplete reasons to VS Code finish reasons
    let finishReason: AdaptedEvent["finishReason"] = "other";
    if (reason === "max_output_tokens" || reason === "max_tokens") {
      finishReason = "length";
    } else if (reason === "content_filter") {
      finishReason = "content-filter";
    }

    const usage = (response?.usage as Usage | null | undefined) ?? undefined;

    return {
      parts: [],
      ...(usage ? { usage } : {}),
      done: true,
      finishReason,
      responseId: response?.id,
    };
  }

  // ===== Output Item Event Handlers =====

  private handleOutputItemAdded(
    event: ResponseOutputItemAddedStreamingEvent,
  ): AdaptedEvent {
    const item = event.item as ItemField | null;

    if (!item) {
      logger.debug(
        `[OpenResponses] output_item.added: item is null (output_index=${event.output_index.toString()})`,
      );
      return { parts: [], done: false };
    }

    // Log the item structure to debug function call detection
    const itemKeys = Object.keys(item);
    const itemType = item.type;
    logger.debug(
      `[OpenResponses] output_item.added: type=${itemType}, keys=[${itemKeys.join(", ")}], output_index=${event.output_index.toString()}`,
    );

    // Check if this is a function call item starting
    // FunctionCall items have: type="function_call", id, call_id, name, arguments, status
    if (item.type === "function_call") {
      const functionCall = item as FunctionCallItem;
      const callId = functionCall.call_id;
      const name = functionCall.name;
      const id = functionCall.id;

      if (callId && name) {
        logger.info(
          `[OpenResponses] Function call streaming started: name=${name}, callId=${callId}, itemId=${id}`,
        );

        this.functionCalls.set(callId, {
          callId,
          name,
          argumentsBuffer: "",
          itemId: id,
        });
      } else {
        logger.warn(
          `[OpenResponses] Function call item missing callId or name: callId=${callId}, name=${name}`,
        );
      }
    } else if ("call_id" in item && "name" in item) {
      // Fallback: detect function call by presence of call_id and name even without type field
      const fallbackItem = item as FunctionCallItemFallback;
      const callId = fallbackItem.call_id;
      const name = fallbackItem.name;
      const id = fallbackItem.id ?? "";

      logger.info(
        `[OpenResponses] Function call detected via call_id/name (no type field): name=${name}, callId=${callId}, itemId=${id}`,
      );

      this.functionCalls.set(callId, {
        callId,
        name,
        argumentsBuffer: "",
        itemId: id,
      });
    } else if (itemType !== "message" && itemType !== "reasoning") {
      // Log any unexpected item types we're not handling
      logger.warn(
        `[OpenResponses] Unhandled output_item.added type: ${itemType}`,
      );
    }

    return { parts: [], done: false };
  }

  private handleOutputItemDone(
    event: ResponseOutputItemDoneStreamingEvent,
  ): AdaptedEvent {
    const item = event.item as ItemField | null;

    // Log what we received
    const itemType = item?.type ?? "no-type";
    const itemKeys = item ? Object.keys(item) : [];
    logger.debug(
      `[OpenResponses] output_item.done: type=${itemType}, keys=[${itemKeys.join(", ")}]`,
    );

    // Check for function_call by type field first (preferred)
    const isFunctionCallByType = item?.type === "function_call";

    // Fallback: check for function call properties
    const isFunctionCallByProps =
      item && "call_id" in item && "arguments" in item && "name" in item;

    // If a function call was completed in full, emit it now
    // (This is a fallback - usually we emit on FunctionCallArgumentsDone)
    if (isFunctionCallByType || isFunctionCallByProps) {
      const functionCall = isFunctionCallByType
        ? (item as FunctionCallItem)
        : (item as FunctionCallItemFallback);
      const callId = functionCall.call_id;
      const argsStr = functionCall.arguments;
      const name = functionCall.name;

      if (typeof argsStr !== "string") {
        logger.warn(
          `[OpenResponses] Function call missing arguments in output_item.done: name=${name}, callId=${callId}`,
        );
        return { parts: [], done: false };
      }

      logger.info(
        `[OpenResponses] Function call completed via output_item.done: name=${name}, callId=${callId}`,
      );

      // Remove from tracking
      this.functionCalls.delete(callId);

      let parsedArgs: ToolCallArguments = {};
      try {
        parsedArgs = JSON.parse(argsStr) as ToolCallArguments;
      } catch (e) {
        logger.warn(
          `[OpenResponses] Failed to parse function call args in output_item.done: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      this.emittedToolCalls.add(callId);

      return {
        parts: [new LanguageModelToolCallPart(callId, name, parsedArgs)],
        done: false,
      };
    }

    return { parts: [], done: false };
  }

  // ===== Content Part Event Handlers =====

  private handleContentPartAdded(
    event: ResponseContentPartAddedStreamingEvent,
  ): AdaptedEvent {
    // A new content part is starting
    // The part type tells us what kind of content to expect
    const part = event.part;
    const partType = part.type;

    logger.debug(
      `[OpenResponses] content_part.added: type=${partType}, item_id=${event.item_id}, content_index=${event.content_index.toString()}`,
    );

    // Initialize tracking based on content type
    if (partType === "output_text" || partType === "text") {
      const key = `${event.item_id}:${event.content_index.toString()}`;
      this.textContent.set(key, {
        itemId: event.item_id,
        contentIndex: event.content_index,
        buffer: "",
      });
    } else if (partType === "refusal") {
      const key = `${event.item_id}:${event.content_index.toString()}`;
      this.refusalContent.set(key, {
        itemId: event.item_id,
        contentIndex: event.content_index,
        buffer: "",
      });
    } else if (partType === "reasoning_text") {
      const key = `${event.item_id}:${event.content_index.toString()}`;
      this.reasoningContent.set(key, {
        itemId: event.item_id,
        contentIndex: event.content_index,
        buffer: "",
      });
    } else {
      // Log any unexpected part types we're not handling
      logger.warn(
        `[OpenResponses] Unhandled content_part.added type: ${partType}`,
      );
    }

    return { parts: [], done: false };
  }

  private handleContentPartDone(
    _event: ResponseContentPartDoneStreamingEvent,
  ): AdaptedEvent {
    void _event;
    // Content part is complete - we've already streamed the deltas,
    // so this is mostly for cleanup
    return { parts: [], done: false };
  }

  // ===== Text Event Handlers =====

  private handleTextDelta(
    event: ResponseOutputTextDeltaStreamingEvent,
  ): AdaptedEvent {
    const delta = event.delta;

    if (delta) {
      return {
        parts: [new LanguageModelTextPart(delta)],
        done: false,
      };
    }

    return { parts: [], done: false };
  }

  private handleTextDone(
    event: ResponseOutputTextDoneStreamingEvent,
  ): AdaptedEvent {
    // The complete text is available, but we've already streamed deltas
    // This is useful for verification or if deltas were missed
    const key = `${event.item_id}:${event.content_index.toString()}`;
    this.textContent.delete(key);

    // Note: We don't emit the full text here since we've streamed it
    // If needed for verification, consumers can compare
    return { parts: [], done: false };
  }

  private handleAnnotationAdded(
    event: ResponseOutputTextAnnotationAddedStreamingEvent,
  ): AdaptedEvent {
    // Annotations are URL citations added to text
    // VS Code doesn't have a direct equivalent, so we could:
    // 1. Append as markdown links (disrupts flow)
    // 2. Store for post-processing
    // 3. Emit as a special part type (not available in VS Code API)

    const annotation = event.annotation as UrlCitationBody | null | undefined;
    if (annotation?.url && annotation.title) {
      // For now, we'll emit annotations as they come so they're not lost
      // This keeps the citation inline with the text
      const url = annotation.url;
      const title = annotation.title;
      const citationText = ` [${title}](${url})`;
      return {
        parts: [new LanguageModelTextPart(citationText)],
        done: false,
      };
    }

    return { parts: [], done: false };
  }

  // ===== Refusal Event Handlers =====

  private handleRefusalDelta(
    event: ResponseRefusalDeltaStreamingEvent,
  ): AdaptedEvent {
    const delta = event.delta;

    // Refusals are content the model declines to provide
    // We format them distinctly so users understand
    if (delta) {
      // Track for potential post-processing
      const key = `${event.item_id}:${event.content_index.toString()}`;
      const state = this.refusalContent.get(key);
      if (state) {
        state.buffer += delta;
      }

      // Emit with italic formatting to distinguish from normal text
      return {
        parts: [new LanguageModelTextPart(`*${delta}*`)],
        done: false,
      };
    }

    return { parts: [], done: false };
  }

  private handleRefusalDone(
    event: ResponseRefusalDoneStreamingEvent,
  ): AdaptedEvent {
    const key = `${event.item_id}:${event.content_index.toString()}`;
    this.refusalContent.delete(key);

    // Refusal is complete - we've already streamed it
    return { parts: [], done: false };
  }

  // ===== Reasoning Event Handlers (for thinking models like o1) =====

  private handleReasoningDelta(
    event: ResponseReasoningDeltaStreamingEvent,
  ): AdaptedEvent {
    const delta = event.delta;

    if (delta) {
      // Track reasoning content
      const key = `${event.item_id}:${event.content_index.toString()}`;
      const state = this.reasoningContent.get(key);
      if (state) {
        state.buffer += delta;
      }

      // Emit reasoning in a blockquote format so it's visually distinct
      // This allows users to see the model's thinking process
      return {
        parts: [new LanguageModelTextPart(delta)],
        done: false,
      };
    }

    return { parts: [], done: false };
  }

  private handleReasoningDone(
    _event: ResponseReasoningDoneStreamingEvent,
  ): AdaptedEvent {
    // Reasoning is complete - cleanup
    const key = `${_event.item_id}:${_event.content_index.toString()}`;
    this.reasoningContent.delete(key);

    return { parts: [], done: false };
  }

  private handleReasoningSummaryDelta(
    event: ResponseReasoningSummaryDeltaStreamingEvent,
  ): AdaptedEvent {
    const delta = event.delta;

    if (delta) {
      // Track summary content
      const key = `${event.item_id}:${event.summary_index.toString()}`;
      const state = this.reasoningSummaries.get(key);
      if (state) {
        state.buffer += delta;
      }

      // Emit summary text (this is a condensed version of reasoning)
      return {
        parts: [new LanguageModelTextPart(delta)],
        done: false,
      };
    }

    return { parts: [], done: false };
  }

  private handleReasoningSummaryDone(
    _event: ResponseReasoningSummaryDoneStreamingEvent,
  ): AdaptedEvent {
    const key = `${_event.item_id}:${_event.summary_index.toString()}`;
    this.reasoningSummaries.delete(key);

    return { parts: [], done: false };
  }

  private handleReasoningSummaryPartAdded(
    event: ResponseReasoningSummaryPartAddedStreamingEvent,
  ): AdaptedEvent {
    // Initialize tracking for a new reasoning summary part
    const key = `${event.item_id}:${event.summary_index.toString()}`;
    this.reasoningSummaries.set(key, {
      itemId: event.item_id,
      summaryIndex: event.summary_index,
      buffer: "",
    });

    return { parts: [], done: false };
  }

  private handleReasoningSummaryPartDone(
    _event: ResponseReasoningSummaryPartDoneStreamingEvent,
  ): AdaptedEvent {
    // Summary part complete
    const key = `${_event.item_id}:${_event.summary_index.toString()}`;
    this.reasoningSummaries.delete(key);

    return { parts: [], done: false };
  }

  // ===== Function Call Event Handlers =====

  private handleFunctionCallArgsDelta(
    event: ResponseFunctionCallArgumentsDeltaStreamingEvent,
  ): AdaptedEvent {
    const delta = event.delta;
    const itemId = event.item_id;

    // Find the function call state by item_id
    for (const state of this.functionCalls.values()) {
      if (state.itemId === itemId) {
        state.argumentsBuffer += delta;
        break;
      }
    }

    // We don't emit anything during delta streaming for tool calls
    // because VS Code expects the complete tool call at once
    return { parts: [], done: false };
  }

  private handleFunctionCallArgsDone(
    event: ResponseFunctionCallArgumentsDoneStreamingEvent,
  ): AdaptedEvent {
    const itemId = event.item_id;
    const finalArguments = event.arguments;

    logger.debug(
      `[OpenResponses] function_call_arguments.done: itemId=${itemId}, argsLen=${String(finalArguments.length)}`,
    );

    // Find and emit the complete function call
    for (const [callId, state] of this.functionCalls) {
      if (state.itemId === itemId) {
        // Use final arguments from done event, or buffered
        const argsString = finalArguments;

        let parsedArgs: ToolCallArguments = {};
        try {
          parsedArgs = JSON.parse(argsString) as ToolCallArguments;
        } catch (e) {
          logger.warn(
            `[OpenResponses] Failed to parse function call args in args.done: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        // Clean up state
        this.functionCalls.delete(callId);

        this.emittedToolCalls.add(callId);

        logger.info(
          `[OpenResponses] Emitting tool call via function_call_arguments.done: ${state.name} (callId: ${callId})`,
        );

        return {
          parts: [
            new LanguageModelToolCallPart(callId, state.name, parsedArgs),
          ],
          done: false,
        };
      }
    }

    // Log if we didn't find the function call - this indicates a bug
    logger.warn(
      `[OpenResponses] function_call_arguments.done received but no matching function call found for itemId=${itemId}. ` +
        `Tracked function calls: ${
          Array.from(this.functionCalls.entries())
            .map(([k, v]) => `${k}:${v.itemId}`)
            .join(", ") || "none"
        }`,
    );

    return { parts: [], done: false };
  }

  // ===== Error Event Handler =====

  private handleError(event: ErrorStreamingEvent): AdaptedEvent {
    const errorPayload = event.error as ErrorPayload | undefined;
    const errorMessage = errorPayload?.message ?? "Unknown error";
    const errorCode = errorPayload?.code ?? "UNKNOWN";

    return {
      parts: [
        new LanguageModelTextPart(
          `\n\n**Error (${errorCode}):** ${errorMessage}\n\n`,
        ),
      ],
      done: true,
      error: errorMessage,
      finishReason: "error",
    };
  }

  // ===== Utility Methods =====

  /**
   * Reset adapter state between requests
   */
  reset(): void {
    this.functionCalls.clear();
    this.emittedToolCalls.clear();
    this.textContent.clear();
    this.refusalContent.clear();
    this.reasoningContent.clear();
    this.reasoningSummaries.clear();
    this.responseId = undefined;
    this.model = undefined;
  }

  /**
   * Get any pending function calls that weren't completed
   * (useful for error recovery)
   */
  getPendingFunctionCalls(): FunctionCallState[] {
    return Array.from(this.functionCalls.values());
  }

  /**
   * Get the response ID captured from lifecycle events
   */
  getResponseId(): string | undefined {
    return this.responseId;
  }

  /**
   * Get the model name captured from lifecycle events
   */
  getModel(): string | undefined {
    return this.model;
  }
}

/**
 * Create a new stream adapter instance
 */
export function createStreamAdapter(): StreamAdapter {
  return new StreamAdapter();
}
