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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  type LanguageModelChatMessage,
  type LanguageModelResponsePart,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
} from "vscode";
import { logger } from "../logger.js";
import {
  encodeStatefulMarker,
  STATEFUL_MARKER_MIME,
} from "../utils/stateful-marker.js";

// Hardcoded to avoid runtime import issues with vscode.LanguageModelChatRole
// 2 = Assistant
const ROLE_ASSISTANT = 2;

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
  /** Whether this terminal event represents a cancellation */
  cancelled?: boolean | undefined;
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
  /** All emitted response parts for the final assistant message */
  private accumulatedParts: LanguageModelResponsePart[] = [];

  /** Function calls being assembled from streaming deltas */
  private functionCalls = new Map<string, FunctionCallState>();

  /** Reverse lookup: callId → responseId for fallback cases */
  private callIdToResponseId = new Map<string, string>();

  /** Generate composite key for function call state */
  private getCallKey(callId: string): string {
    return `${this.responseId ?? "unknown"}:${callId}`;
  }

  /** Tool calls already emitted to VS Code (tracked by itemId) */
  private emittedToolCalls = new Set<string>();

  /**
   * Tool calls already emitted, tracked by call_id (gateway's identifier).
   * The gateway can emit duplicate output_item.added events with different itemIds
   * but the same call_id. We must dedupe by call_id to prevent duplicate execution.
   */
  private emittedCallIds = new Set<string>();

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
    let result: AdaptedEvent;
    switch (event.type) {
      // ===== Lifecycle Events =====
      case "response.created":
        result = this.handleResponseCreated(event);
        break;

      case "response.queued":
        result = this.handleResponseQueued(event);
        break;

      case "response.in_progress":
        result = this.handleResponseInProgress(event);
        break;

      case "response.completed":
        result = this.handleResponseCompleted(event);
        break;

      case "response.failed":
        result = this.handleResponseFailed(event);
        break;

      case "response.incomplete":
        result = this.handleResponseIncomplete(event);
        break;

      // ===== Output Item Events =====
      case "response.output_item.added":
        result = this.handleOutputItemAdded(event);
        break;

      case "response.output_item.done":
        result = this.handleOutputItemDone(event);
        break;

      // ===== Content Part Events =====
      case "response.content_part.added":
        result = this.handleContentPartAdded(event);
        break;

      case "response.content_part.done":
        result = this.handleContentPartDone(event);
        break;

      // ===== Text Events =====
      case "response.output_text.delta":
        result = this.handleTextDelta(event);
        break;

      case "response.output_text.done":
        result = this.handleTextDone(event);
        break;

      case "response.output_text.annotation.added":
        result = this.handleAnnotationAdded(event);
        break;

      // ===== Refusal Events =====
      case "response.refusal.delta":
        result = this.handleRefusalDelta(event);
        break;

      case "response.refusal.done":
        result = this.handleRefusalDone(event);
        break;

      // ===== Reasoning Events (for thinking models) =====
      case "response.reasoning.delta":
        result = this.handleReasoningDelta(event);
        break;

      case "response.reasoning.done":
        result = this.handleReasoningDone(event);
        break;

      case "response.reasoning_summary_text.delta":
        result = this.handleReasoningSummaryDelta(event);
        break;

      case "response.reasoning_summary_text.done":
        result = this.handleReasoningSummaryDone(event);
        break;

      case "response.reasoning_summary_part.added":
        result = this.handleReasoningSummaryPartAdded(event);
        break;

      case "response.reasoning_summary_part.done":
        result = this.handleReasoningSummaryPartDone(event);
        break;

      // ===== Function Call Events =====
      case "response.function_call_arguments.delta":
        result = this.handleFunctionCallArgsDelta(event);
        break;

      case "response.function_call_arguments.done":
        result = this.handleFunctionCallArgsDone(event);
        break;

      // ===== Error Events =====
      case "error":
        result = this.handleError(event);
        break;

      default: {
        // TypeScript exhaustiveness check - this should never happen
        // If we get here, a new event type was added to OpenResponses
        const _exhaustive: never = event;
        void _exhaustive;
        console.warn(
          `Unhandled streaming event type: ${(event as StreamingEvent).type}`,
        );
        result = { parts: [], done: false };
        break;
      }
    }

    if (result.parts.length > 0) {
      this.accumulatedParts.push(...result.parts);
    }

    return result;
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

    // Log response ID chain for RFC 052 delta caching investigation
    logger.info(
      `[OpenResponses] Response chain: id=${response.id ?? "null"}, previous_response_id=${response.previous_response_id ?? "null"}`,
    );

    // Append to response chain log for forensic analysis
    try {
      const logDir = path.join(os.homedir(), ".vscode-ai-gateway");
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, "response-chain.jsonl");
      const entry = {
        timestamp: new Date().toISOString(),
        responseId: response.id,
        previousResponseId: response.previous_response_id,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
        model: response.model,
      };
      fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
    } catch (err) {
      logger.warn(
        `[OpenResponses] Failed to write response chain log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Log the raw response for debugging stop_reason issues
    const rawResponse = response as unknown as {
      stop_reason?: string;
      status?: string;
      incomplete_details?: unknown;
    };
    if (
      rawResponse.stop_reason ||
      rawResponse.status ||
      rawResponse.incomplete_details
    ) {
      logger.info(
        `[OpenResponses] Response metadata: stop_reason=${rawResponse.stop_reason ?? "n/a"}, status=${rawResponse.status ?? "n/a"}, incomplete_details=${JSON.stringify(rawResponse.incomplete_details ?? null)}`,
      );
    }

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
        const itemId = functionCall.id; // Use itemId as unique identifier!
        const callId = functionCall.call_id;
        const hasCallId = typeof callId === "string" && callId.length > 0;
        const callIdAlreadyEmitted = hasCallId
          ? this.emittedCallIds.has(callId)
          : false;
        const name = functionCall.name;
        const argsStr = functionCall.arguments;

        logger.debug(
          `[OpenResponses] Found function_call in output: name=${name}, callId=${callId}, itemId=${itemId}, argsLen=${argsStr.length.toString()}`,
        );

        // Only emit if this tool call wasn't already emitted via streaming events
        // Check BOTH itemId AND callId - the gateway can emit duplicate output items
        // with different itemIds but the same callId (same logical tool call)
        if (
          itemId &&
          name &&
          !this.emittedToolCalls.has(itemId) &&
          !callIdAlreadyEmitted
        ) {
          let parsedArgs: ToolCallArguments = {};
          try {
            parsedArgs = JSON.parse(argsStr) as ToolCallArguments;
          } catch (e) {
            logger.warn(
              `[OpenResponses] Failed to parse function_call arguments: ${e instanceof Error ? e.message : String(e)}`,
            );
          }

          logger.info(
            `[OpenResponses] Emitting tool call from completion payload: ${name} (itemId: ${itemId})`,
          );
          // CRITICAL: Use itemId as the callId sent to VS Code, not the gateway's call_id!
          // The gateway can reuse call_id for multiple function calls, but VS Code needs unique IDs.
          parts.push(new LanguageModelToolCallPart(itemId, name, parsedArgs));
          this.emittedToolCalls.add(itemId);
          if (hasCallId) {
            this.emittedCallIds.add(callId);
          }
          functionCallsEmitted++;
        } else if (this.emittedToolCalls.has(itemId) || callIdAlreadyEmitted) {
          functionCallsSkippedDuplicate++;
          logger.debug(
            `[OpenResponses] Skipping duplicate tool call: ${name} (itemId: ${itemId}, callId: ${callId})`,
          );
        } else {
          logger.warn(
            `[OpenResponses] Skipping tool call with missing itemId or name: itemId=${itemId}, name=${name}`,
          );
        }
      }
    }

    if (functionCallsFound > 0) {
      logger.info(
        `[OpenResponses] Completion output tool calls: found=${functionCallsFound.toString()}, emitted=${functionCallsEmitted.toString()}, skippedDupe=${functionCallsSkippedDuplicate.toString()}`,
      );
    }

    // DIAGNOSTIC: Log if there are pending function calls that were never completed
    if (this.functionCalls.size > 0) {
      const pending = Array.from(this.functionCalls.entries())
        .map(([callId, state]) => `${state.name}(${callId})`)
        .join(", ");
      logger.warn(
        `[OpenResponses] INCOMPLETE FUNCTION CALLS at stream end: ${this.functionCalls.size.toString()} pending: ${pending}`,
      );
    }

    // DIAGNOSTIC: Log total emitted tool calls
    logger.debug(
      `[OpenResponses] Total tool calls emitted during stream: ${this.emittedToolCalls.size.toString()}`,
    );

    if (response.id) {
      const modelId = response.model ?? this.model ?? "unknown";
      const marker = encodeStatefulMarker(modelId, {
        provider: "openresponses",
        modelId,
        sdkMode: "openai-responses",
        sessionId: response.id, // Use response ID as session for now
        responseId: response.id,
      });
      parts.push(new LanguageModelDataPart(marker, STATEFUL_MARKER_MIME));
      logger.debug(
        `[OpenResponses] Emitting stateful marker with responseId=${response.id}`,
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
    const errorCode =
      responseError?.code !== undefined
        ? String(responseError.code)
        : undefined;

    if (this.isCancellationError(errorMessage, errorCode)) {
      return {
        parts: [],
        done: true,
        cancelled: true,
        finishReason: "other",
        responseId: response?.id,
      };
    }

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
    const cancelled = this.isCancellationReason(reason);

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
      ...(cancelled ? { cancelled } : {}),
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

        const key = this.getCallKey(callId);
        this.functionCalls.set(key, {
          callId,
          name,
          argumentsBuffer: "",
          itemId: id,
        });
        this.callIdToResponseId.set(callId, this.responseId ?? "unknown");
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

      const key = this.getCallKey(callId);
      this.functionCalls.set(key, {
        callId,
        name,
        argumentsBuffer: "",
        itemId: id,
      });
      this.callIdToResponseId.set(callId, this.responseId ?? "unknown");
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
      const itemId = isFunctionCallByType
        ? (item as FunctionCallItem).id
        : ((item as FunctionCallItemFallback).id ?? functionCall.call_id);
      const callId = functionCall.call_id;
      const hasCallId = typeof callId === "string" && callId.length > 0;
      const callIdAlreadyEmitted = hasCallId
        ? this.emittedCallIds.has(callId)
        : false;
      const argsStr = functionCall.arguments;
      const name = functionCall.name;

      // Skip if already emitted via function_call_arguments.done
      // Check BOTH itemId AND callId - the gateway can emit duplicate output items
      // with different itemIds but the same callId (same logical tool call)
      if (this.emittedToolCalls.has(itemId) || callIdAlreadyEmitted) {
        logger.debug(
          `[OpenResponses] Skipping duplicate output_item.done for already-emitted tool call: ${name} (itemId: ${itemId}, callId: ${callId})`,
        );
        return { parts: [], done: false };
      }

      if (typeof argsStr !== "string") {
        logger.warn(
          `[OpenResponses] Function call missing arguments in output_item.done: name=${name}, itemId=${itemId}`,
        );
        return { parts: [], done: false };
      }

      logger.info(
        `[OpenResponses] Function call completed via output_item.done: name=${name}, itemId=${itemId}`,
      );

      // Remove from tracking (keyed by callId for now, but we track emission by itemId)
      const responseIdForCall =
        this.callIdToResponseId.get(callId) ?? this.responseId ?? "unknown";
      this.functionCalls.delete(`${responseIdForCall}:${callId}`);
      this.callIdToResponseId.delete(callId);

      let parsedArgs: ToolCallArguments = {};
      try {
        parsedArgs = JSON.parse(argsStr) as ToolCallArguments;
      } catch (e) {
        logger.warn(
          `[OpenResponses] Failed to parse function call args in output_item.done: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      this.emittedToolCalls.add(itemId);
      if (hasCallId) {
        this.emittedCallIds.add(callId);
      }

      // CRITICAL: Use itemId as the callId sent to VS Code!
      return {
        parts: [new LanguageModelToolCallPart(itemId, name, parsedArgs)],
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

      // Emit reasoning delta as plain text; no formatting is applied here.
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
    // Note: The Vercel AI Gateway sometimes sends call_id in the item_id field,
    // so we also check if item_id matches the callId key directly
    let state: FunctionCallState | undefined;
    for (const s of this.functionCalls.values()) {
      if (s.itemId === itemId) {
        state = s;
        break;
      }
    }

    // Fallback: check if item_id is actually the call_id
    if (!state) {
      // Try with current responseId
      state = this.functionCalls.get(this.getCallKey(itemId));
      // Fallback: try with stored responseId for this callId
      if (!state) {
        const storedResponseId = this.callIdToResponseId.get(itemId);
        if (storedResponseId) {
          state = this.functionCalls.get(`${storedResponseId}:${itemId}`);
        }
      }
      if (state) {
        logger.debug(
          `[OpenResponses] function_call_arguments.delta: found state via callId lookup (itemId=${itemId})`,
        );
      }
    }

    if (state) {
      state.argumentsBuffer += delta;
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

    // Find the function call state by item_id first
    let foundCallId: string | undefined;
    let foundState: FunctionCallState | undefined;

    for (const [compositeKey, state] of this.functionCalls) {
      if (state.itemId === itemId) {
        foundCallId = compositeKey;
        foundState = state;
        break;
      }
    }

    // Fallback: check if item_id is actually the call_id
    // The Vercel AI Gateway sometimes sends call_id in the item_id field
    if (!foundState) {
      // Try with current responseId first
      const compositeKey = this.getCallKey(itemId);
      foundState = this.functionCalls.get(compositeKey);
      if (foundState) {
        foundCallId = compositeKey;
        logger.debug(
          `[OpenResponses] function_call_arguments.done: found state via composite key lookup (itemId=${itemId}, name=${foundState.name})`,
        );
      } else {
        // Fallback: try with stored responseId for this callId
        const storedResponseId = this.callIdToResponseId.get(itemId);
        if (storedResponseId) {
          const storedCompositeKey = `${storedResponseId}:${itemId}`;
          foundState = this.functionCalls.get(storedCompositeKey);
          if (foundState) {
            foundCallId = storedCompositeKey;
            logger.debug(
              `[OpenResponses] function_call_arguments.done: found state via stored responseId lookup (itemId=${itemId}, name=${foundState.name})`,
            );
          }
        }
      }
    }

    if (foundCallId && foundState) {
      // Check if already emitted via output_item.done or a previous function_call_arguments.done
      // Check BOTH itemId AND callId - the gateway can emit duplicate output items
      // with different itemIds but the same callId (same logical tool call)
      const hasCallId =
        typeof foundState.callId === "string" && foundState.callId.length > 0;
      const callIdAlreadyEmitted = hasCallId
        ? this.emittedCallIds.has(foundState.callId)
        : false;
      if (
        this.emittedToolCalls.has(foundState.itemId) ||
        callIdAlreadyEmitted
      ) {
        logger.debug(
          `[OpenResponses] Skipping duplicate function_call_arguments.done: ${foundState.name} (itemId: ${foundState.itemId}, callId: ${foundState.callId})`,
        );
        this.functionCalls.delete(foundCallId); // Still clean up
        return { parts: [], done: false };
      }

      // Use final arguments from done event
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
      this.functionCalls.delete(foundCallId);
      this.callIdToResponseId.delete(foundState.callId);
      // Track by BOTH itemId and callId to catch all duplicate patterns
      this.emittedToolCalls.add(foundState.itemId);
      if (hasCallId) {
        this.emittedCallIds.add(foundState.callId);
      }

      logger.info(
        `[OpenResponses] Emitting tool call via function_call_arguments.done: ${foundState.name} (itemId: ${foundState.itemId})`,
      );

      // CRITICAL: Use itemId as the callId sent to VS Code!
      // The gateway can reuse call_id for multiple function calls, but VS Code needs unique IDs.
      return {
        parts: [
          new LanguageModelToolCallPart(
            foundState.itemId,
            foundState.name,
            parsedArgs,
          ),
        ],
        done: false,
      };
    }

    // Log if we didn't find the function call - this indicates a bug or timing issue
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

    if (this.isCancellationError(errorMessage, errorCode)) {
      return {
        parts: [],
        done: true,
        cancelled: true,
        finishReason: "other",
        responseId: this.responseId,
        model: this.model,
      };
    }

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
    this.accumulatedParts = [];
    this.functionCalls.clear();
    this.callIdToResponseId.clear();
    this.emittedToolCalls.clear();
    this.emittedCallIds.clear();
    this.textContent.clear();
    this.refusalContent.clear();
    this.reasoningContent.clear();
    this.reasoningSummaries.clear();
    this.responseId = undefined;
    this.model = undefined;
  }

  /**
   * Get the final assistant message assembled from streamed parts.
   */
  getFinalMessage(): LanguageModelChatMessage {
    return {
      role: ROLE_ASSISTANT as any,
      content: this.accumulatedParts,
      name: undefined,
    };
  }

  private isCancellationError(message?: string, code?: string): boolean {
    const combined = `${code ?? ""} ${message ?? ""}`.toLowerCase();
    return combined.includes("cancel") || combined.includes("abort");
  }

  private isCancellationReason(reason?: string): boolean {
    if (!reason) return false;
    const normalized = reason.toLowerCase();
    return normalized.includes("cancel") || normalized.includes("abort");
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
