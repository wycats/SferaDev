/**
 * OpenResponses Client
 *
 * A minimal TypeScript client for the OpenResponses API with streaming support.
 */

export type {
	ClientOptions,
	CreateResponseBody,
	ErrorEvent,
	LogCallback,
	ResponseCompletedEvent,
	ResponseFailedEvent,
	ResponseResource,
	StreamingEvent,
	TextDeltaEvent,
	Usage,
} from "./client.js";
export {
	createClient,
	isError,
	isResponseCompleted,
	isResponseFailed,
	isTextDelta,
	OpenResponsesError,
} from "./client.js";

// Re-export all generated types for advanced usage
export type * from "./generated/types/index.ts";

// Convenience type aliases for ALL streaming events
// These are exported individually for consumers who want high-fidelity type checking

/** Lifecycle Events */
/** Output Item Events */
/** Content Part Events */
/** Text Events */
/** Refusal Events */
/** Reasoning Events */
/** Function Call Events */
/** Input/Output Types */
export type {
	AssistantMessageItemParam,
	FunctionCallItemParam,
	FunctionCallOutputItemParam,
	FunctionToolParam,
	InputImageContentParamAutoParam,
	InputTextContentParam,
	ItemField,
	ItemParam,
	OutputTextContentParam,
	ResponseContentPartAddedStreamingEvent as ContentPartAddedEvent,
	ResponseContentPartDoneStreamingEvent as ContentPartDoneEvent,
	ResponseCreatedStreamingEvent as ResponseCreatedEvent,
	ResponseFunctionCallArgumentsDeltaStreamingEvent as FunctionCallArgsDeltaEvent,
	ResponseFunctionCallArgumentsDoneStreamingEvent as FunctionCallArgsDoneEvent,
	ResponseIncompleteStreamingEvent as ResponseIncompleteEvent,
	ResponseInProgressStreamingEvent as ResponseInProgressEvent,
	ResponseOutputItemAddedStreamingEvent as OutputItemAddedEvent,
	ResponseOutputItemDoneStreamingEvent as OutputItemDoneEvent,
	ResponseOutputTextAnnotationAddedStreamingEvent as AnnotationAddedEvent,
	ResponseOutputTextDoneStreamingEvent as OutputTextDoneEvent,
	ResponseQueuedStreamingEvent as ResponseQueuedEvent,
	ResponseReasoningDeltaStreamingEvent as ReasoningDeltaEvent,
	ResponseReasoningDoneStreamingEvent as ReasoningDoneEvent,
	ResponseReasoningSummaryDeltaStreamingEvent as ReasoningSummaryDeltaEvent,
	ResponseReasoningSummaryDoneStreamingEvent as ReasoningSummaryDoneEvent,
	ResponseReasoningSummaryPartAddedStreamingEvent as ReasoningSummaryPartAddedEvent,
	ResponseReasoningSummaryPartDoneStreamingEvent as ReasoningSummaryPartDoneEvent,
	ResponseRefusalDeltaStreamingEvent as RefusalDeltaEvent,
	ResponseRefusalDoneStreamingEvent as RefusalDoneEvent,
	SystemMessageItemParam,
	UserMessageItemParam,
} from "./generated/types/index.ts";
