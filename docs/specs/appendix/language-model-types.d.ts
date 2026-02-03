// Extracted from vscode.d.ts (Language Model API types)
// Source: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.d.ts
// Extracted on: 2026-01-29

export enum LanguageModelChatMessageRole {
	/**
	 * The user role, e.g the human interacting with a language model.
	 */
	User = 1,

	/**
	 * The assistant role, e.g. the language model generating responses.
	 */
	Assistant = 2,
}

/**
 * Represents a message in a chat. Can assume different roles, like user or assistant.
 */
export class LanguageModelChatMessage {
	/**
	 * Utility to create a new user message.
	 *
	 * @param content The content of the message.
	 * @param name The optional name of a user for the message.
	 */
	static User(
		content:
			| string
			| Array<LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelDataPart>,
		name?: string,
	): LanguageModelChatMessage;

	/**
	 * Utility to create a new assistant message.
	 *
	 * @param content The content of the message.
	 * @param name The optional name of a user for the message.
	 */
	static Assistant(
		content:
			| string
			| Array<LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelDataPart>,
		name?: string,
	): LanguageModelChatMessage;

	/**
	 * The role of this message.
	 */
	role: LanguageModelChatMessageRole;

	/**
	 * A string or heterogeneous array of things that a message can contain as content. Some parts may be message-type
	 * specific for some models.
	 */
	content: Array<LanguageModelInputPart>;

	/**
	 * The optional name of a user for this message.
	 */
	name: string | undefined;

	/**
	 * Create a new user message.
	 *
	 * @param role The role of the message.
	 * @param content The content of the message.
	 * @param name The optional name of a user for the message.
	 */
	constructor(
		role: LanguageModelChatMessageRole,
		content: string | Array<LanguageModelInputPart>,
		name?: string,
	);
}

/**
 * Represents a language model response.
 *
 * @see {@link ChatRequest}
 */
export interface LanguageModelChatResponse {
	/**
	 * An async iterable that is a stream of text and tool-call parts forming the overall response. A
	 * {@link LanguageModelTextPart} is part of the assistant's response to be shown to the user. A
	 * {@link LanguageModelToolCallPart} is a request from the language model to call a tool. The latter will
	 * only be returned if tools were passed in the request via {@link LanguageModelChatRequestOptions.tools}. The
	 * `unknown`-type is used as a placeholder for future parts, like image data parts.
	 *
	 * *Note* that this stream will error when during data receiving an error occurs. Consumers of the stream should handle
	 * the errors accordingly.
	 *
	 * To cancel the stream, the consumer can {@link CancellationTokenSource.cancel cancel} the token that was used to make
	 * the request or break from the for-loop.
	 *
	 * @example
	 * ```ts
	 * try {
	 *   // consume stream
	 *   for await (const chunk of response.stream) {
	 *      if (chunk instanceof LanguageModelTextPart) {
	 *        console.log("TEXT", chunk);
	 *      } else if (chunk instanceof LanguageModelToolCallPart) {
	 *        console.log("TOOL CALL", chunk);
	 *      }
	 *   }
	 *
	 * } catch(e) {
	 *   // stream ended with an error
	 *   console.error(e);
	 * }
	 * ```
	 */
	stream: AsyncIterable<
		LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelDataPart | unknown
	>;

	/**
	 * This is equivalent to filtering everything except for text parts from a {@link LanguageModelChatResponse.stream}.
	 *
	 * @see {@link LanguageModelChatResponse.stream}
	 */
	text: AsyncIterable<string>;
}

/**
 * Represents a language model for making chat requests.
 *
 * @see {@link lm.selectChatModels}
 */
export interface LanguageModelChat {
	/**
	 * Human-readable name of the language model.
	 */
	readonly name: string;

	/**
	 * Opaque identifier of the language model.
	 */
	readonly id: string;

	/**
	 * A well-known identifier of the vendor of the language model. An example is `copilot`, but
	 * values are defined by extensions contributing chat models and need to be looked up with them.
	 */
	readonly vendor: string;

	/**
	 * Opaque family-name of the language model. Values might be `gpt-3.5-turbo`, `gpt4`, `phi2`, or `llama`
	 * but they are defined by extensions contributing languages and subject to change.
	 */
	readonly family: string;

	/**
	 * Opaque version string of the model. This is defined by the extension contributing the language model
	 * and subject to change.
	 */
	readonly version: string;

	/**
	 * The maximum number of tokens that can be sent to the model in a single request.
	 */
	readonly maxInputTokens: number;

	/**
	 * Make a chat request using a language model.
	 *
	 * *Note* that language model use may be subject to access restrictions and user consent. Calling this function
	 * for the first time (for an extension) will show a consent dialog to the user and because of that this function
	 * must _only be called in response to a user action!_ Extensions can use {@link LanguageModelAccessInformation.canSendRequest}
	 * to check if they have the necessary permissions to make a request.
	 *
	 * This function will return a rejected promise if making a request to the language model is not
	 * possible. Reasons for this can be:
	 *
	 * - user consent not given, see {@link LanguageModelError.NoPermissions `NoPermissions`}
	 * - model does not exist anymore, see {@link LanguageModelError.NotFound `NotFound`}
	 * - quota limits exceeded, see {@link LanguageModelError.Blocked `Blocked`}
	 * - other issues in which case extension must check {@link LanguageModelError.cause `LanguageModelError.cause`}
	 *
	 * An extension can make use of language model tool calling by passing a set of tools to
	 * {@link LanguageModelChatRequestOptions.tools}. The language model will return a {@link LanguageModelToolCallPart} and
	 * the extension can invoke the tool and make another request with the result.
	 *
	 * @param messages An array of message instances.
	 * @param options Options that control the request.
	 * @param token A cancellation token which controls the request. See {@link CancellationTokenSource} for how to create one.
	 * @returns A thenable that resolves to a {@link LanguageModelChatResponse}. The promise will reject when the request couldn't be made.
	 */
	sendRequest(
		messages: LanguageModelChatMessage[],
		options?: LanguageModelChatRequestOptions,
		token?: CancellationToken,
	): Thenable<LanguageModelChatResponse>;

	/**
		 * Count the number of tokens in a message using the model specific tokenizer-logic.

		 * @param text A string or a message instance.
		 * @param token Optional cancellation token.  See {@link CancellationTokenSource} for how to create one.
		 * @returns A thenable that resolves to the number of tokens.
		 */
	countTokens(text: string | LanguageModelChatMessage, token?: CancellationToken): Thenable<number>;
}

/**
 * Describes how to select language models for chat requests.
 *
 * @see {@link lm.selectChatModels}
 */
export interface LanguageModelChatSelector {
	/**
	 * A vendor of language models.
	 * @see {@link LanguageModelChat.vendor}
	 */
	vendor?: string;

	/**
	 * A family of language models.
	 * @see {@link LanguageModelChat.family}
	 */
	family?: string;

	/**
	 * The version of a language model.
	 * @see {@link LanguageModelChat.version}
	 */
	version?: string;

	/**
	 * The identifier of a language model.
	 * @see {@link LanguageModelChat.id}
	 */
	id?: string;
}

/**
 * An error type for language model specific errors.
 *
 * Consumers of language models should check the code property to determine specific
 * failure causes, like `if(someError.code === vscode.LanguageModelError.NotFound.name) {...}`
 * for the case of referring to an unknown language model. For unspecified errors the `cause`-property
 * will contain the actual error.
 */
export class LanguageModelError extends Error {
	/**
	 * The requestor does not have permissions to use this
	 * language model
	 */
	static NoPermissions(message?: string): LanguageModelError;

	/**
	 * The requestor is blocked from using this language model.
	 */
	static Blocked(message?: string): LanguageModelError;

	/**
	 * The language model does not exist.
	 */
	static NotFound(message?: string): LanguageModelError;

	/**
	 * A code that identifies this error.
	 *
	 * Possible values are names of errors, like {@linkcode LanguageModelError.NotFound NotFound},
	 * or `Unknown` for unspecified errors from the language model itself. In the latter case the
	 * `cause`-property will contain the actual error.
	 */
	readonly code: string;
}

/**
 * Options for making a chat request using a language model.
 *
 * @see {@link LanguageModelChat.sendRequest}
 */
export interface LanguageModelChatRequestOptions {
	/**
	 * A human-readable message that explains why access to a language model is needed and what feature is enabled by it.
	 */
	justification?: string;

	/**
	 * A set of options that control the behavior of the language model. These options are specific to the language model
	 * and need to be looked up in the respective documentation.
	 */
	modelOptions?: { [name: string]: any };

	/**
	 * An optional list of tools that are available to the language model. These could be registered tools available via
	 * {@link lm.tools}, or private tools that are just implemented within the calling extension.
	 *
	 * If the LLM requests to call one of these tools, it will return a {@link LanguageModelToolCallPart} in
	 * {@link LanguageModelChatResponse.stream}. It's the caller's responsibility to invoke the tool. If it's a tool
	 * registered in {@link lm.tools}, that means calling {@link lm.invokeTool}.
	 *
	 * Then, the tool result can be provided to the LLM by creating an Assistant-type {@link LanguageModelChatMessage} with a
	 * {@link LanguageModelToolCallPart}, followed by a User-type message with a {@link LanguageModelToolResultPart}.
	 */
	tools?: LanguageModelChatTool[];

	/**
	 * 	The tool-selecting mode to use. {@link LanguageModelChatToolMode.Auto} by default.
	 */
	toolMode?: LanguageModelChatToolMode;
}

/**
 * McpStdioServerDefinition represents an MCP server available by running
 * a local process and operating on its stdin and stdout streams. The process
 * will be spawned as a child process of the extension host and by default
 * will not run in a shell environment.
 */
export class McpStdioServerDefinition {
	/**
	 * The human-readable name of the server.
	 */
	readonly label: string;

	/**
	 * The working directory used to start the server.
	 */
	cwd?: Uri;

	/**
	 * The command used to start the server. Node.js-based servers may use
	 * `process.execPath` to use the editor's version of Node.js to run the script.
	 */
	command: string;

	/**
	 * Additional command-line arguments passed to the server.
	 */
	args: string[];

	/**
	 * Optional additional environment information for the server. Variables
	 * in this environment will overwrite or remove (if null) the default
	 * environment variables of the editor's extension host.
	 */
	env: Record<string, string | number | null>;

	/**
	 * Optional version identification for the server. If this changes, the
	 * editor will indicate that tools have changed and prompt to refresh them.
	 */
	version?: string;

	/**
	 * @param label The human-readable name of the server.
	 * @param command The command used to start the server.
	 * @param args Additional command-line arguments passed to the server.
	 * @param env Optional additional environment information for the server.
	 * @param version Optional version identification for the server.
	 */
	constructor(
		label: string,
		command: string,
		args?: string[],
		env?: Record<string, string | number | null>,
		version?: string,
	);
}

/**
 * McpHttpServerDefinition represents an MCP server available using the
 * Streamable HTTP transport.
 */
export class McpHttpServerDefinition {
	/**
	 * The human-readable name of the server.
	 */
	readonly label: string;

	/**
	 * The URI of the server. The editor will make a POST request to this URI
	 * to begin each session.
	 */
	uri: Uri;

	/**
	 * Optional additional heads included with each request to the server.
	 */
	headers: Record<string, string>;

	/**
	 * Optional version identification for the server. If this changes, the
	 * editor will indicate that tools have changed and prompt to refresh them.
	 */
	version?: string;

	/**
	 * @param label The human-readable name of the server.
	 * @param uri The URI of the server.
	 * @param headers Optional additional heads included with each request to the server.
	 */
	constructor(label: string, uri: Uri, headers?: Record<string, string>, version?: string);
}

/**
 * Definitions that describe different types of Model Context Protocol servers,
 * which can be returned from the {@link McpServerDefinitionProvider}.
 */
export type McpServerDefinition = McpStdioServerDefinition | McpHttpServerDefinition;

/**
 * A type that can provide Model Context Protocol server definitions. This
 * should be registered using {@link lm.registerMcpServerDefinitionProvider}
 * during extension activation.
 */
export interface McpServerDefinitionProvider<T extends McpServerDefinition = McpServerDefinition> {
	/**
	 * Optional event fired to signal that the set of available servers has changed.
	 */
	readonly onDidChangeMcpServerDefinitions?: Event<void>;

	/**
	 * Provides available MCP servers. The editor will call this method eagerly
	 * to ensure the availability of servers for the language model, and so
	 * extensions should not take actions which would require user
	 * interaction, such as authentication.
	 *
	 * @param token A cancellation token.
	 * @returns An array of MCP available MCP servers
	 */
	provideMcpServerDefinitions(token: CancellationToken): ProviderResult<T[]>;

	/**
	 * This function will be called when the editor needs to start a MCP server.
	 * At this point, the extension may take any actions which may require user
	 * interaction, such as authentication. Any non-`readonly` property of the
	 * server may be modified, and the extension should return the resolved server.
	 *
	 * The extension may return undefined to indicate that the server
	 * should not be started, or throw an error. If there is a pending tool
	 * call, the editor will cancel it and return an error message to the
	 * language model.
	 *
	 * @param server The MCP server to resolve
	 * @param token A cancellation token.
	 * @returns The resolved server or thenable that resolves to such. This may
	 * be the given `server` definition with non-readonly properties filled in.
	 */
	resolveMcpServerDefinition?(server: T, token: CancellationToken): ProviderResult<T>;
}

/**
 * The provider version of {@linkcode LanguageModelChatRequestOptions}
 */
export interface ProvideLanguageModelChatResponseOptions {
	/**
	 * A set of options that control the behavior of the language model. These options are specific to the language model.
	 */
	readonly modelOptions?: { readonly [name: string]: any };

	/**
	 * An optional list of tools that are available to the language model. These could be registered tools available via
	 * {@link lm.tools}, or private tools that are just implemented within the calling extension.
	 *
	 * If the LLM requests to call one of these tools, it will return a {@link LanguageModelToolCallPart} in
	 * {@link LanguageModelChatResponse.stream}. It's the caller's responsibility to invoke the tool. If it's a tool
	 * registered in {@link lm.tools}, that means calling {@link lm.invokeTool}.
	 *
	 * Then, the tool result can be provided to the LLM by creating an Assistant-type {@link LanguageModelChatMessage} with a
	 * {@link LanguageModelToolCallPart}, followed by a User-type message with a {@link LanguageModelToolResultPart}.
	 */
	readonly tools?: readonly LanguageModelChatTool[];

	/**
	 * 	The tool-selecting mode to use. The provider must implement respecting this.
	 */
	readonly toolMode: LanguageModelChatToolMode;
}

/**
 * Represents a language model provided by a {@linkcode LanguageModelChatProvider}.
 */
export interface LanguageModelChatInformation {
	/**
	 * Unique identifier for the language model. Must be unique per provider, but not required to be globally unique.
	 */
	readonly id: string;

	/**
	 * Human-readable name of the language model.
	 */
	readonly name: string;

	/**
	 * Opaque family-name of the language model. Values might be `gpt-3.5-turbo`, `gpt4`, `phi2`, or `llama`
	 */
	readonly family: string;

	/**
	 * The tooltip to render when hovering the model. Used to provide more information about the model.
	 */
	readonly tooltip?: string;

	/**
	 * An optional, human-readable string which will be rendered alongside the model.
	 * Useful for distinguishing models of the same name in the UI.
	 */
	readonly detail?: string;

	/**
	 * Opaque version string of the model.
	 * This is used as a lookup value in {@linkcode LanguageModelChatSelector.version}
	 * An example is how GPT 4o has multiple versions like 2024-11-20 and 2024-08-06
	 */
	readonly version: string;

	/**
	 * The maximum number of tokens the model can accept as input.
	 */
	readonly maxInputTokens: number;

	/**
	 * The maximum number of tokens the model is capable of producing.
	 */
	readonly maxOutputTokens: number;

	/**
	 * Various features that the model supports such as tool calling or image input.
	 */
	readonly capabilities: LanguageModelChatCapabilities;
}

/**
 * Various features that the {@link LanguageModelChatInformation} supports such as tool calling or image input.
 */
export interface LanguageModelChatCapabilities {
	/**
	 * Whether image input is supported by the model.
	 * Common supported images are jpg and png, but each model will vary in supported mimetypes.
	 */
	readonly imageInput?: boolean;

	/**
	 * Whether tool calling is supported by the model.
	 * If a number is provided, that is the maximum number of tools that can be provided in a request to the model.
	 */
	readonly toolCalling?: boolean | number;
}

/**
 * The provider version of {@linkcode LanguageModelChatMessage}.
 */
export interface LanguageModelChatRequestMessage {
	/**
	 * The role of this message.
	 */
	readonly role: LanguageModelChatMessageRole;

	/**
	 * A heterogeneous array of things that a message can contain as content. Some parts may be message-type
	 * specific for some models.
	 */
	readonly content: ReadonlyArray<LanguageModelInputPart | unknown>;

	/**
	 * The optional name of a user for this message.
	 */
	readonly name: string | undefined;
}

/**
 * The various message types which a {@linkcode LanguageModelChatProvider} can emit in the chat response stream
 */
export type LanguageModelResponsePart =
	| LanguageModelTextPart
	| LanguageModelToolResultPart
	| LanguageModelToolCallPart
	| LanguageModelDataPart;

/**
 * The various message types which can be sent via {@linkcode LanguageModelChat.sendRequest } and processed by a {@linkcode LanguageModelChatProvider}
 */
export type LanguageModelInputPart =
	| LanguageModelTextPart
	| LanguageModelToolResultPart
	| LanguageModelToolCallPart
	| LanguageModelDataPart;

/**
 * A LanguageModelChatProvider implements access to language models, which users can then use through the chat view, or through extension API by acquiring a LanguageModelChat.
 * An example of this would be an OpenAI provider that provides models like gpt-5, o3, etc.
 */
export interface LanguageModelChatProvider<
	T extends LanguageModelChatInformation = LanguageModelChatInformation,
> {
	/**
	 * An optional event fired when the available set of language models changes.
	 */
	readonly onDidChangeLanguageModelChatInformation?: Event<void>;

	/**
	 * Get the list of available language models provided by this provider
	 * @param options Options which specify the calling context of this function
	 * @param token A cancellation token
	 * @returns The list of available language models
	 */
	provideLanguageModelChatInformation(
		options: PrepareLanguageModelChatModelOptions,
		token: CancellationToken,
	): ProviderResult<T[]>;

	/**
	 * Returns the response for a chat request, passing the results to the progress callback.
	 * The {@linkcode LanguageModelChatProvider} must emit the response parts to the progress callback as they are received from the language model.
	 * @param model The language model to use
	 * @param messages The messages to include in the request
	 * @param options Options for the request
	 * @param progress The progress to emit the streamed response chunks to
	 * @param token A cancellation token
	 * @returns A promise that resolves when the response is complete. Results are actually passed to the progress callback.
	 */
	provideLanguageModelChatResponse(
		model: T,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart>,
		token: CancellationToken,
	): Thenable<void>;

	/**
	 * Returns the number of tokens for a given text using the model-specific tokenizer logic
	 * @param model The language model to use
	 * @param text The text to count tokens for
	 * @param token A cancellation token
	 * @returns The number of tokens
	 */
	provideTokenCount(
		model: T,
		text: string | LanguageModelChatRequestMessage,
		token: CancellationToken,
	): Thenable<number>;
}

/**
 * The list of options passed into {@linkcode LanguageModelChatProvider.provideLanguageModelChatInformation}
 */
export interface PrepareLanguageModelChatModelOptions {
	/**
	 * Whether or not the user should be prompted via some UI flow, or if models should be attempted to be resolved silently.
	 * If silent is true, all models may not be resolved due to lack of info such as API keys.
	 */
	readonly silent: boolean;
}

/**
 * Namespace for language model related functionality.
 */
export namespace lm {
	/**
	 * An event that is fired when the set of available chat models changes.
	 */
	export const onDidChangeChatModels: Event<void>;

	/**
	 * Select chat models by a {@link LanguageModelChatSelector selector}. This can yield multiple or no chat models and
	 * extensions must handle these cases, esp. when no chat model exists, gracefully.
	 *
	 * ```ts
	 * const models = await vscode.lm.selectChatModels({ family: 'gpt-3.5-turbo' });
	 * if (models.length > 0) {
	 * 	const [first] = models;
	 * 	const response = await first.sendRequest(...)
	 * 	// ...
	 * } else {
	 * 	// NO chat models available
	 * }
	 * ```
	 *
	 * A selector can be written to broadly match all models of a given vendor or family, or it can narrowly select one model by ID.
	 * Keep in mind that the available set of models will change over time, but also that prompts may perform differently in
	 * different models.
	 *
	 * *Note* that extensions can hold on to the results returned by this function and use them later. However, when the
	 * {@link onDidChangeChatModels}-event is fired the list of chat models might have changed and extensions should re-query.
	 *
	 * @param selector A chat model selector. When omitted all chat models are returned.
	 * @returns An array of chat models, can be empty!
	 */
	export function selectChatModels(
		selector?: LanguageModelChatSelector,
	): Thenable<LanguageModelChat[]>;

	/**
	 * Register a LanguageModelTool. The tool must also be registered in the package.json `languageModelTools` contribution
	 * point. A registered tool is available in the {@link lm.tools} list for any extension to see. But in order for it to
	 * be seen by a language model, it must be passed in the list of available tools in {@link LanguageModelChatRequestOptions.tools}.
	 * @returns A {@link Disposable} that unregisters the tool when disposed.
	 */
	export function registerTool<T>(name: string, tool: LanguageModelTool<T>): Disposable;

	/**
	 * A list of all available tools that were registered by all extensions using {@link lm.registerTool}. They can be called
	 * with {@link lm.invokeTool} with input that match their declared `inputSchema`.
	 */
	export const tools: readonly LanguageModelToolInformation[];

	/**
	 * Invoke a tool listed in {@link lm.tools} by name with the given input. The input will be validated against
	 * the schema declared by the tool
	 *
	 * A tool can be invoked by a chat participant, in the context of handling a chat request, or globally by any extension in
	 * any custom flow.
	 *
	 * In the former case, the caller shall pass the
	 * {@link LanguageModelToolInvocationOptions.toolInvocationToken toolInvocationToken}, which comes from a
	 * {@link ChatRequest.toolInvocationToken chat request}. This makes sure the chat UI shows the tool invocation for the
	 * correct conversation.
	 *
	 * A tool {@link LanguageModelToolResult result} is an array of {@link LanguageModelTextPart text-} and
	 * {@link LanguageModelPromptTsxPart prompt-tsx}-parts. If the tool caller is using `@vscode/prompt-tsx`, it can
	 * incorporate the response parts into its prompt using a `ToolResult`. If not, the parts can be passed along to the
	 * {@link LanguageModelChat} via a user message with a {@link LanguageModelToolResultPart}.
	 *
	 * If a chat participant wants to preserve tool results for requests across multiple turns, it can store tool results in
	 * the {@link ChatResult.metadata} returned from the handler and retrieve them on the next turn from
	 * {@link ChatResponseTurn.result}.
	 *
	 * @param name The name of the tool to call.
	 * @param options The options to use when invoking the tool.
	 * @param token A cancellation token. See {@link CancellationTokenSource} for how to create one.
	 * @returns The result of the tool invocation.
	 */
	export function invokeTool(
		name: string,
		options: LanguageModelToolInvocationOptions<object>,
		token?: CancellationToken,
	): Thenable<LanguageModelToolResult>;

	/**
	 * Registers a provider that publishes Model Context Protocol servers for the editor to
	 * consume. This allows MCP servers to be dynamically provided to the editor in
	 * addition to those the user creates in their configuration files.
	 *
	 * Before calling this method, extensions must register the `contributes.mcpServerDefinitionProviders`
	 * extension point with the corresponding {@link id}, for example:
	 *
	 * ```js
	 * 	"contributes": {
	 * 		"mcpServerDefinitionProviders": [
	 * 			{
	 * 				"id": "cool-cloud-registry.mcp-servers",
	 * 				"label": "Cool Cloud Registry",
	 * 			}
	 * 		]
	 * 	}
	 * ```
	 *
	 * When a new McpServerDefinitionProvider is available, the editor will, by default,
	 * automatically invoke it to discover new servers and tools when a chat message is
	 * submitted. To enable this flow, extensions should call
	 * `registerMcpServerDefinitionProvider` during activation.
	 *
	 * @param id The ID of the provider, which is unique to the extension.
	 * @param provider The provider to register
	 * @returns A disposable that unregisters the provider when disposed.
	 */
	export function registerMcpServerDefinitionProvider(
		id: string,
		provider: McpServerDefinitionProvider,
	): Disposable;

	/**
	 * Registers a {@linkcode LanguageModelChatProvider}
	 * Note: You must also define the language model chat provider via the `languageModelChatProviders` contribution point in package.json
	 * @param vendor The vendor for this provider. Must be globally unique. An example is `copilot` or `openai`.
	 * @param provider The provider to register
	 * @returns A disposable that unregisters the provider when disposed
	 */
	export function registerLanguageModelChatProvider(
		vendor: string,
		provider: LanguageModelChatProvider,
	): Disposable;
}

/**
 * Represents extension specific information about the access to language models.
 */
export interface LanguageModelAccessInformation {
	/**
	 * An event that fires when access information changes.
	 */
	readonly onDidChange: Event<void>;

	/**
	 * Checks if a request can be made to a language model.
	 *
	 * *Note* that calling this function will not trigger a consent UI but just checks for a persisted state.
	 *
	 * @param chat A language model chat object.
	 * @return `true` if a request can be made, `false` if not, `undefined` if the language
	 * model does not exist or consent hasn't been asked for.
	 */
	canSendRequest(chat: LanguageModelChat): boolean | undefined;
}

/**
 * A tool that is available to the language model via {@link LanguageModelChatRequestOptions}. A language model uses all the
 * properties of this interface to decide which tool to call, and how to call it.
 */
export interface LanguageModelChatTool {
	/**
	 * The name of the tool.
	 */
	name: string;

	/**
	 * The description of the tool.
	 */
	description: string;

	/**
	 * A JSON schema for the input this tool accepts.
	 */
	inputSchema?: object | undefined;
}

/**
 * A tool-calling mode for the language model to use.
 */
export enum LanguageModelChatToolMode {
	/**
	 * The language model can choose to call a tool or generate a message. Is the default.
	 */
	Auto = 1,

	/**
	 * The language model must call one of the provided tools. Note- some models only support a single tool when using this
	 * mode.
	 */
	Required = 2,
}

/**
 * A language model response part indicating a tool call, returned from a {@link LanguageModelChatResponse}, and also can be
 * included as a content part on a {@link LanguageModelChatMessage}, to represent a previous tool call in a chat request.
 */
export class LanguageModelToolCallPart {
	/**
	 * The ID of the tool call. This is a unique identifier for the tool call within the chat request.
	 */
	callId: string;

	/**
	 * The name of the tool to call.
	 */
	name: string;

	/**
	 * The input with which to call the tool.
	 */
	input: object;

	/**
	 * Create a new LanguageModelToolCallPart.
	 *
	 * @param callId The ID of the tool call.
	 * @param name The name of the tool to call.
	 * @param input The input with which to call the tool.
	 */
	constructor(callId: string, name: string, input: object);
}

/**
 * The result of a tool call. This is the counterpart of a {@link LanguageModelToolCallPart tool call} and
 * it can only be included in the content of a User message
 */
export class LanguageModelToolResultPart {
	/**
	 * The ID of the tool call.
	 *
	 * *Note* that this should match the {@link LanguageModelToolCallPart.callId callId} of a tool call part.
	 */
	callId: string;

	/**
	 * The value of the tool result.
	 */
	content: Array<
		LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown
	>;

	/**
	 * @param callId The ID of the tool call.
	 * @param content The content of the tool result.
	 */
	constructor(
		callId: string,
		content: Array<
			LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown
		>,
	);
}

/**
 * A language model response part containing a piece of text, returned from a {@link LanguageModelChatResponse}.
 */
export class LanguageModelTextPart {
	/**
	 * The text content of the part.
	 */
	value: string;

	/**
	 * Construct a text part with the given content.
	 * @param value The text content of the part.
	 */
	constructor(value: string);
}

/**
 * A language model response part containing a PromptElementJSON from `@vscode/prompt-tsx`.
 * @see {@link LanguageModelToolResult}
 */
export class LanguageModelPromptTsxPart {
	/**
	 * The value of the part.
	 */
	value: unknown;

	/**
	 * Construct a prompt-tsx part with the given content.
	 * @param value The value of the part, the result of `renderElementJSON` from `@vscode/prompt-tsx`.
	 */
	constructor(value: unknown);
}

/**
 * A result returned from a tool invocation. If using `@vscode/prompt-tsx`, this result may be rendered using a `ToolResult`.
 */
export class LanguageModelToolResult {
	/**
	 * A list of tool result content parts. Includes `unknown` because this list may be extended with new content types in
	 * the future.
	 * @see {@link lm.invokeTool}.
	 */
	content: Array<
		LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown
	>;

	/**
	 * Create a LanguageModelToolResult
	 * @param content A list of tool result content parts
	 */
	constructor(
		content: Array<
			LanguageModelTextPart | LanguageModelPromptTsxPart | LanguageModelDataPart | unknown
		>,
	);
}

/**
 * A language model response part containing arbitrary data. Can be used in {@link LanguageModelChatResponse responses},
 * {@link LanguageModelChatMessage chat messages}, {@link LanguageModelToolResult tool results}, and other language model interactions.
 */
export class LanguageModelDataPart {
	/**
	 * Create a new {@linkcode LanguageModelDataPart} for an image.
	 * @param data Binary image data
	 * @param mime The MIME type of the image. Common values are `image/png` and `image/jpeg`.
	 */
	static image(data: Uint8Array, mime: string): LanguageModelDataPart;

	/**
	 * Create a new {@linkcode LanguageModelDataPart} for a json.
	 *
	 * *Note* that this function is not expecting "stringified JSON" but
	 * an object that can be stringified. This function will throw an error
	 * when the passed value cannot be JSON-stringified.
	 * @param value  A JSON-stringifyable value.
	 * @param mime Optional MIME type, defaults to `application/json`
	 */
	static json(value: any, mime?: string): LanguageModelDataPart;

	/**
	 * Create a new {@linkcode LanguageModelDataPart} for text.
	 *
	 * *Note* that an UTF-8 encoder is used to create bytes for the string.
	 * @param value Text data
	 * @param mime The MIME type if any. Common values are `text/plain` and `text/markdown`.
	 */
	static text(value: string, mime?: string): LanguageModelDataPart;

	/**
	 * The mime type which determines how the data property is interpreted.
	 */
	mimeType: string;

	/**
	 * The byte data for this part.
	 */
	data: Uint8Array;

	/**
	 * Construct a generic data part with the given content.
	 * @param data The byte data for this part.
	 * @param mimeType The mime type of the data.
	 */
	constructor(data: Uint8Array, mimeType: string);
}

/**
 * A token that can be passed to {@link lm.invokeTool} when invoking a tool inside the context of handling a chat request.
 */
export type ChatParticipantToolToken = never;
