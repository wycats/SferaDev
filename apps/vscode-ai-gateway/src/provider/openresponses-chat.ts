/**
 * OpenResponses Chat Implementation
 *
 * Provides the chat implementation using the OpenResponses API directly,
 * bypassing the Vercel AI SDK for more accurate token usage reporting.
 *
 * This implementation:
 * - Uses the openresponses-client package for HTTP/SSE streaming
 * - Handles ALL 24 streaming event types with high fidelity
 * - Reports accurate token usage from the API response
 * - Maintains compatibility with the existing provider interface
 */

import {
	type CreateResponseBody,
	createClient,
	type FunctionToolParam,
	type InputImageContentParamAutoParam,
	type InputTextContentParam,
	type ItemParam,
	OpenResponsesError,
	type OutputTextContentParam,
	type Usage,
} from "openresponses-client";
import {
	type CancellationToken,
	type LanguageModelChatInformation,
	type LanguageModelChatMessage,
	LanguageModelChatMessageRole,
	LanguageModelChatToolMode,
	LanguageModelDataPart,
	type LanguageModelResponsePart,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	type Progress,
	type ProvideLanguageModelChatResponseOptions,
} from "vscode";
import type { ConfigService } from "../config.js";
import { logger } from "../logger.js";
import type { TokenStatusBar } from "../status-bar.js";
import { type AdaptedEvent, StreamAdapter } from "./stream-adapter.js";
import { UsageTracker } from "./usage-tracker.js";

/**
 * Options for the OpenResponses chat implementation
 */
export interface OpenResponsesChatOptions {
	/** Configuration service for settings */
	configService: ConfigService;
	/** Status bar for token display */
	statusBar: TokenStatusBar | null;
	/** API key for authentication */
	apiKey: string;
	/** Estimated input tokens (for status bar) */
	estimatedInputTokens: number;
	/** Chat ID for logging/tracking */
	chatId: string;
}

/**
 * Result of the OpenResponses chat implementation
 */
export interface OpenResponsesChatResult {
	/** Usage data from the API response */
	usage?: Usage;
	/** Whether the response completed successfully */
	success: boolean;
	/** Error message if the response failed */
	error?: string;
	/** Response ID from the API */
	responseId?: string;
	/** Finish reason from the API */
	finishReason?: AdaptedEvent["finishReason"];
}

/**
 * Execute a chat request using the OpenResponses API.
 *
 * This function handles the full lifecycle:
 * 1. Translate VS Code messages to OpenResponses format
 * 2. Stream the response via SSE
 * 3. Adapt events to VS Code parts
 * 4. Report token usage
 */
export async function executeOpenResponsesChat(
	model: LanguageModelChatInformation,
	chatMessages: readonly LanguageModelChatMessage[],
	options: ProvideLanguageModelChatResponseOptions,
	progress: Progress<LanguageModelResponsePart>,
	token: CancellationToken,
	chatOptions: OpenResponsesChatOptions,
): Promise<OpenResponsesChatResult> {
	const { configService, statusBar, apiKey, estimatedInputTokens, chatId } = chatOptions;

	// TRACE: Log raw VS Code messages
	logger.trace(`[OpenResponses] Received ${chatMessages.length} messages from VS Code`);
	for (let i = 0; i < chatMessages.length; i++) {
		const msg = chatMessages[i];
		const roleName =
			msg.role === LanguageModelChatMessageRole.User
				? "User"
				: msg.role === LanguageModelChatMessageRole.Assistant
					? "Assistant"
					: `Unknown(${msg.role})`;
		const contentTypes = msg.content.map((p) => p.constructor.name).join(", ");
		logger.trace(`[OpenResponses] Message[${i}]: role=${roleName}, parts=[${contentTypes}]`);
	}

	// Create client with trace logging
	const client = createClient({
		baseUrl: configService.openResponsesBaseUrl,
		apiKey,
		timeout: configService.timeout,
		log: (level, message, data) => {
			const formatted =
				data !== undefined ? `${message}: ${JSON.stringify(data, null, 2)}` : message;
			switch (level) {
				case "trace":
					logger.trace(formatted);
					break;
				case "debug":
					logger.debug(formatted);
					break;
				case "info":
					logger.info(formatted);
					break;
				case "warn":
					logger.warn(formatted);
					break;
				case "error":
					logger.error(formatted);
					break;
			}
		},
	});

	const adapter = new StreamAdapter();
	const usageTracker = new UsageTracker();

	// Set up abort handling
	const abortController = new AbortController();
	const abortSubscription = token.onCancellationRequested(() => abortController.abort());

	// Start tracking in status bar
	statusBar?.startAgent(chatId, estimatedInputTokens, model.maxInputTokens, model.id);

	let responseSent = false;
	let result: OpenResponsesChatResult = { success: false };

	try {
		// Translate messages to OpenResponses format
		const { input, instructions, tools, toolChoice } = translateRequest(
			chatMessages,
			options,
			configService,
		);

		// Build the request body
		const requestBody: CreateResponseBody = {
			model: model.id,
			input,
			stream: true,
			temperature: options.modelOptions?.temperature ?? 0.7,
			max_output_tokens: options.modelOptions?.maxOutputTokens ?? 4096,
		};

		if (instructions) {
			requestBody.instructions = instructions;
		}

		if (tools.length > 0) {
			requestBody.tools = tools;
			requestBody.tool_choice = toolChoice;
		}

		logger.debug(`[OpenResponses] Starting streaming request to ${model.id}`);

		// DEBUG: Log the full request body for troubleshooting
		logger.debug(`[OpenResponses] Full request body: ${JSON.stringify(requestBody, null, 2)}`);

		// TRACE: Log the first few input items to debug structure
		logger.trace(`[OpenResponses] Request has ${input.length} input items`);
		for (let i = 0; i < Math.min(3, input.length); i++) {
			const item = input[i];
			logger.trace(
				`[OpenResponses] input[${i}]: type=${item.type}, role=${"role" in item ? item.role : "N/A"}`,
			);
			if ("content" in item && Array.isArray(item.content)) {
				const contentTypes = item.content
					.map((c: { type?: string }) => c.type || "unknown")
					.join(", ");
				logger.trace(`[OpenResponses] input[${i}] content types: [${contentTypes}]`);
			}
		}

		// Stream the response
		for await (const event of client.createStreamingResponse(requestBody, abortController.signal)) {
			const adapted = adapter.adapt(event);

			// Report all parts to VS Code
			for (const part of adapted.parts) {
				progress.report(part);
				responseSent = true;
			}

			// Handle completion
			if (adapted.done) {
				result = {
					success: !adapted.error,
					usage: adapted.usage,
					error: adapted.error,
					responseId: adapted.responseId,
					finishReason: adapted.finishReason,
				};

				// Track usage
				if (adapted.usage) {
					usageTracker.record(chatId, adapted.usage);
					logger.info(
						`[OpenResponses] Response completed: ${adapted.usage.input_tokens} input, ` +
							`${adapted.usage.output_tokens} output tokens`,
					);

					// Update status bar with actual usage
					statusBar?.completeAgent(chatId, {
						inputTokens: adapted.usage.input_tokens,
						outputTokens: adapted.usage.output_tokens,
						maxInputTokens: model.maxInputTokens,
						modelId: model.id,
					});
				}
				break;
			}
		}

		// Safety check: emit something if no response was sent
		if (!responseSent) {
			logger.error(`[OpenResponses] Stream completed with no content for chat ${chatId}`);
			progress.report(
				new LanguageModelTextPart(
					`**Error**: No response received from model. The request completed but the model returned no content. Please try again.`,
				),
			);
			result = { success: false, error: "No content received" };
		}

		return result;
	} catch (error) {
		// Handle abort/cancellation
		if (
			error instanceof Error &&
			(error.name === "AbortError" || error.message.includes("abort"))
		) {
			logger.debug(`[OpenResponses] Request was cancelled`);
			return { success: false, error: "Cancelled" };
		}

		// Handle API errors
		const errorMessage =
			error instanceof OpenResponsesError
				? `${error.message} (${error.code ?? error.status})`
				: error instanceof Error
					? error.message
					: "Unknown error";

		logger.error(`[OpenResponses] Request failed: ${errorMessage}`);

		// Emit error to user if we haven't sent anything yet
		if (!responseSent) {
			progress.report(new LanguageModelTextPart(`\n\n**Error:** ${errorMessage}\n\n`));
		}

		statusBar?.errorAgent(chatId);

		return { success: false, error: errorMessage };
	} finally {
		abortSubscription.dispose();
		adapter.reset();
	}
}

/**
 * Translate a VS Code chat request to OpenResponses format.
 */
function translateRequest(
	messages: readonly LanguageModelChatMessage[],
	options: ProvideLanguageModelChatResponseOptions,
	configService: ConfigService,
): {
	input: ItemParam[];
	instructions?: string;
	tools: FunctionToolParam[];
	toolChoice: "auto" | "required" | "none";
} {
	const input: ItemParam[] = [];

	// Handle system prompt
	const systemPromptEnabled = configService.systemPromptEnabled;
	const systemPromptMessage = configService.systemPromptMessage;
	let instructions: string | undefined;

	if (systemPromptEnabled && systemPromptMessage?.trim()) {
		// VS Code does not provide a system/developer role in LanguageModelChatMessageRole.
		// System prompts are passed via options (config-driven here), so we map them to
		// OpenResponses `instructions` instead of synthesizing a message.
		// If VS Code introduces system/developer roles in the future, they will be mapped
		// explicitly in translateMessage via resolveOpenResponsesRole().
		// Use instructions field for system prompt (OpenResponses preferred approach)
		instructions = systemPromptMessage;
	}

	// Build tool name map for resolving tool result -> tool call relationships
	const toolNameMap = buildToolNameMap(messages);

	// Convert each message
	for (const message of messages) {
		const translated = translateMessage(message, toolNameMap);
		input.push(...translated);
	}

	// Convert tools
	const tools: FunctionToolParam[] = [];
	for (const { name, description, inputSchema } of options.tools || []) {
		tools.push({
			type: "function",
			name,
			description: description ?? undefined,
			// Cast to null to satisfy the optional parameters field
			// The API accepts the schema but TypeScript types are strict
			parameters: (inputSchema ?? {
				type: "object",
				properties: {},
			}) as FunctionToolParam["parameters"],
			strict: false,
		} as unknown as FunctionToolParam);
	}

	// Determine tool choice
	let toolChoice: "auto" | "required" | "none" = "auto";
	if (options.toolMode === LanguageModelChatToolMode.Required) {
		toolChoice = "required";
	} else if (tools.length === 0) {
		toolChoice = "none";
	}

	return { input, instructions, tools, toolChoice };
}

/**
 * Build a mapping of tool call IDs to tool names.
 */
function buildToolNameMap(messages: readonly LanguageModelChatMessage[]): Map<string, string> {
	const map = new Map<string, string>();

	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof LanguageModelToolCallPart) {
				map.set(part.callId, part.name);
			}
		}
	}

	return map;
}

/**
 * Translate a single VS Code message to OpenResponses items.
 */
function translateMessage(
	message: LanguageModelChatMessage,
	_toolNameMap: Map<string, string>,
): ItemParam[] {
	const items: ItemParam[] = [];
	const role = message.role;
	const openResponsesRole = resolveOpenResponsesRole(role);

	// DEBUG: Log the incoming role
	logger.trace(
		`[OpenResponses] translateMessage role=${role} (User=${LanguageModelChatMessageRole.User}, Assistant=${LanguageModelChatMessageRole.Assistant}) mapped=${openResponsesRole}`,
	);

	// Collect content parts
	type UserContent = InputTextContentParam | InputImageContentParamAutoParam;
	type AssistantContent = OutputTextContentParam;
	const contentParts: (UserContent | AssistantContent)[] = [];

	for (const part of message.content) {
		if (part instanceof LanguageModelTextPart) {
			// Text content
			// Use input_text for User role, and also for unknown roles (which become user messages)
			// Only use output_text for Assistant role
			if (openResponsesRole === "assistant") {
				contentParts.push({
					type: "output_text",
					text: part.value,
				});
			} else {
				contentParts.push({
					type: "input_text",
					text: part.value,
				});
			}
		} else if (part instanceof LanguageModelDataPart) {
			// Binary data - images
			if (part.mimeType.startsWith("image/") && openResponsesRole === "user") {
				const base64 = Buffer.from(part.data).toString("base64");
				const imageUrl = `data:${part.mimeType};base64,${base64}`;
				contentParts.push({
					type: "input_image",
					image_url: imageUrl,
				});
			}
		} else if (part instanceof LanguageModelToolCallPart) {
			// Flush content first
			if (contentParts.length > 0) {
				items.push(createMessageItem(openResponsesRole, [...contentParts]));
				contentParts.length = 0;
			}

			// Add function call
			items.push({
				type: "function_call",
				call_id: part.callId,
				name: part.name,
				arguments: JSON.stringify(part.input ?? {}),
			});
		} else if (part instanceof LanguageModelToolResultPart) {
			// Flush content first
			if (contentParts.length > 0) {
				items.push(createMessageItem(openResponsesRole, [...contentParts]));
				contentParts.length = 0;
			}

			// Add function call output
			const output = typeof part.content === "string" ? part.content : JSON.stringify(part.content);

			items.push({
				type: "function_call_output",
				call_id: part.callId,
				output,
			});
		}
	}

	// Flush remaining content
	if (contentParts.length > 0) {
		items.push(createMessageItem(openResponsesRole, contentParts));
	}

	return items;
}

/**
 * Create a message item from content parts.
 *
 * NOTE: We deliberately omit "system" role here. The OpenResponses API rejects
 * `role: "system"` in input messages. Use the `instructions` field for system
 * prompts, or use "developer" role for message-based system-like content.
 */
function createMessageItem(
	role: "user" | "assistant" | "developer",
	content: (InputTextContentParam | InputImageContentParamAutoParam | OutputTextContentParam)[],
): ItemParam {
	switch (role) {
		case "user":
			return {
				type: "message",
				role: "user",
				content: content as (InputTextContentParam | InputImageContentParamAutoParam)[],
			};

		case "assistant":
			return {
				type: "message",
				role: "assistant",
				content: content as OutputTextContentParam[],
			};

		case "developer":
			return {
				type: "message",
				role: "developer",
				content: content as InputTextContentParam[],
			};

		default:
			// Treat unknown roles as user messages
			return {
				type: "message",
				role: "user",
				content: content as (InputTextContentParam | InputImageContentParamAutoParam)[],
			};
	}
}

/**
 * Resolve a VS Code chat message role to an OpenResponses role.
 *
 * VS Code currently exposes only User/Assistant roles. System/developer prompts
 * are supplied via options (handled as OpenResponses `instructions`). If VS Code
 * adds system/developer roles in the future, we map them here.
 *
 * NOTE: We intentionally map unknown roles (including what VS Code might call
 * "System") to "developer" rather than "system", because the OpenResponses API
 * currently rejects `role: "system"` in input messages with a 400 error.
 * System-level instructions should go in the `instructions` field instead.
 */
function resolveOpenResponsesRole(
	role: LanguageModelChatMessageRole,
): "user" | "assistant" | "developer" {
	if (role === LanguageModelChatMessageRole.User) return "user";
	if (role === LanguageModelChatMessageRole.Assistant) return "assistant";

	// Any other role (including Unknown/System from VS Code) gets mapped to
	// "developer". This is the closest equivalent to a system message in the
	// OpenResponses input array, and unlike "system", it's accepted by the API.
	return "developer";
}
