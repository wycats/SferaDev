import { Context, Data, Effect, Layer, Schema } from "effect";

// ============================================================================
// Configuration Schema
// ============================================================================

/**
 * Schema for API client configuration.
 * Provides runtime validation and type inference.
 */
export const ApiClientConfig = Schema.Struct({
	/** Base URL for the API */
	baseUrl: Schema.String,
	/** Bearer token for authentication */
	token: Schema.optional(Schema.String),
	/** Additional headers to include in all requests */
	headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
	/** Request timeout in milliseconds */
	timeout: Schema.optional(Schema.Number),
});

export type ApiClientConfig = typeof ApiClientConfig.Type;

/**
 * Schema for API client request options.
 */
export const ApiClientRequest = Schema.Struct({
	method: Schema.String,
	url: Schema.String,
	body: Schema.optional(Schema.Unknown),
	headers: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Union(Schema.String, Schema.Number) }),
	),
});

export type ApiClientRequest = typeof ApiClientRequest.Type;

// ============================================================================
// Error Types
// ============================================================================

/**
 * Validation error for client-side input validation failures.
 * Use this for missing required parameters or invalid input formats.
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
	readonly field: string;
	readonly message: string;
}> {
	override get message(): string {
		return `Validation error for '${this.field}': ${this.message}`;
	}
}

/**
 * API error with status code and error payload.
 * Uses Effect's Data.TaggedError for pattern matching support.
 */
export class ApiError extends Data.TaggedError("ApiError")<{
	readonly status: number;
	readonly error: unknown;
}> {
	override get message(): string {
		if (this.error && typeof this.error === "object" && "message" in this.error) {
			return String((this.error as { message: unknown }).message);
		}
		return `API Error: ${this.status}`;
	}
}

/**
 * Network error for fetch failures (timeouts, DNS errors, etc).
 */
export class NetworkError extends Data.TaggedError("NetworkError")<{
	readonly cause: unknown;
}> {
	override get message(): string {
		if (this.cause instanceof Error) {
			return `Network error: ${this.cause.message}`;
		}
		return "Network error";
	}
}

// ============================================================================
// API Client Service
// ============================================================================

/**
 * API client service interface for making HTTP requests.
 */
export type ApiClientService = {
	readonly request: <T>(
		options: ApiClientRequest,
	) => Effect.Effect<T, ApiError | NetworkError | ValidationError>;
};

/**
 * Effect Context tag for the API client service.
 */
export class ApiClient extends Context.Tag("ApiClient")<ApiClient, ApiClientService>() {}

// ============================================================================
// Query Parameter Serialization
// ============================================================================

/**
 * Serialize query parameters to a URLSearchParams string.
 * Handles arrays, nested objects, and undefined values.
 */
export function serializeQueryParams(params: Record<string, unknown> | undefined): string {
	if (!params) return "";

	const searchParams = new URLSearchParams();

	const appendParam = (key: string, value: unknown): void => {
		if (value === undefined || value === null) return;

		if (Array.isArray(value)) {
			// Handle arrays: ?ids=1&ids=2&ids=3
			for (const item of value) {
				if (item !== undefined && item !== null) {
					searchParams.append(key, String(item));
				}
			}
		} else if (typeof value === "object") {
			// Handle nested objects: ?filter[status]=active&filter[type]=user
			for (const [nestedKey, nestedValue] of Object.entries(value)) {
				appendParam(`${key}[${nestedKey}]`, nestedValue);
			}
		} else {
			searchParams.append(key, String(value));
		}
	};

	for (const [key, value] of Object.entries(params)) {
		appendParam(key, value);
	}

	return searchParams.toString();
}

// ============================================================================
// API Client Implementation
// ============================================================================

/**
 * Create a live implementation of the API client.
 *
 * @param config - Configuration for the API client
 * @returns A Layer that provides the ApiClient service
 */
export const makeApiClientLive = (config: {
	baseUrl: string;
	token?: string;
	headers?: Record<string, string>;
	timeout?: number;
}): Layer.Layer<ApiClient> => {
	// Validate config at runtime
	const validatedConfig = Schema.decodeUnknownSync(ApiClientConfig)(config);

	return Layer.succeed(
		ApiClient,
		ApiClient.of({
			request: <T>(
				options: ApiClientRequest,
			): Effect.Effect<T, ApiError | NetworkError | ValidationError> =>
				Effect.tryPromise({
					try: async () => {
						// Convert all header values to strings
						const stringifyHeaders = (
							headers: Record<string, string | number> | undefined,
						): Record<string, string> => {
							if (!headers) return {};
							return Object.fromEntries(
								Object.entries(headers).map(([key, value]) => [key, String(value)]),
							);
						};

						const headers: HeadersInit = {
							"Content-Type": "application/json",
							...validatedConfig.headers,
							...stringifyHeaders(options.headers),
						};

						if (validatedConfig.token) {
							(headers as Record<string, string>).Authorization = `Bearer ${validatedConfig.token}`;
						}

						// Handle multipart/form-data - browser sets boundary automatically
						if (
							typeof headers === "object" &&
							"Content-Type" in headers &&
							String(headers["Content-Type"]).includes("multipart/form-data")
						) {
							delete (headers as Record<string, string>)["Content-Type"];
						}

						const body =
							options.body instanceof FormData
								? options.body
								: options.body !== undefined
									? JSON.stringify(options.body)
									: undefined;

						const fullUrl = `${validatedConfig.baseUrl}${options.url}`;

						// Create abort controller for timeout
						const controller = new AbortController();
						let timeoutId: ReturnType<typeof setTimeout> | undefined;

						if (validatedConfig.timeout) {
							timeoutId = setTimeout(() => controller.abort(), validatedConfig.timeout);
						}

						try {
							const response = await fetch(fullUrl, {
								method: options.method,
								headers,
								body,
								signal: controller.signal,
							});

							if (!response.ok) {
								let errorPayload: unknown;
								try {
									errorPayload = await response.json();
								} catch {
									errorPayload = { message: await response.text() };
								}
								throw new ApiError({ status: response.status, error: errorPayload });
							}

							const contentType = response.headers.get("content-type");
							if (contentType?.includes("application/json")) {
								return (await response.json()) as T;
							}
							return (await response.text()) as unknown as T;
						} finally {
							if (timeoutId) {
								clearTimeout(timeoutId);
							}
						}
					},
					catch: (error) => {
						if (error instanceof ApiError) {
							return error;
						}
						if (error instanceof ValidationError) {
							return error;
						}
						return new NetworkError({ cause: error });
					},
				}),
		}),
	);
};

// ============================================================================
// Cached API Client (for ApiClientLive)
// ============================================================================

let cachedEnvLayer: Layer.Layer<ApiClient> | null = null;

/**
 * Default API client layer using environment variables.
 * The layer is cached after first use for efficiency.
 */
export const makeApiClientFromEnv = (
	envTokenKey: string,
	baseUrl: string,
): Layer.Layer<ApiClient> => {
	if (cachedEnvLayer) {
		return cachedEnvLayer;
	}

	const token = typeof process !== "undefined" ? process.env?.[envTokenKey] : undefined;
	cachedEnvLayer = makeApiClientLive({ baseUrl, token });
	return cachedEnvLayer;
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Run an Effect program with the API client configured.
 * Best for one-off API calls or scripts.
 */
export const runWithClient = <A, E>(
	config: {
		baseUrl: string;
		token?: string;
		headers?: Record<string, string>;
		timeout?: number;
	},
	effect: Effect.Effect<A, E, ApiClient>,
): Promise<A> => {
	return effect.pipe(Effect.provide(makeApiClientLive(config)), Effect.runPromise);
};

/**
 * Create a reusable API client for making multiple requests.
 * Ideal for applications that need to make many API calls.
 */
export const createClient = (config: {
	baseUrl: string;
	token?: string;
	headers?: Record<string, string>;
	timeout?: number;
}) => {
	const layer = makeApiClientLive(config);

	return {
		/**
		 * Run an Effect program with this client's configuration.
		 */
		run: <A, E>(effect: Effect.Effect<A, E, ApiClient>): Promise<A> =>
			effect.pipe(Effect.provide(layer), Effect.runPromise),

		/**
		 * Run an Effect program, returning an Exit (success or failure).
		 * Useful when you want to handle errors without throwing.
		 */
		runExit: <A, E>(effect: Effect.Effect<A, E, ApiClient>) =>
			effect.pipe(Effect.provide(layer), Effect.runPromiseExit),

		/**
		 * Get the Layer for advanced composition scenarios.
		 */
		layer,
	};
};
