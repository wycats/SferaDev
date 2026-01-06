import { Context, Data, Effect, Layer } from "effect";

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for the Effect-based API client.
 */
export interface ApiClientConfig {
	/** Base URL for the API. Defaults to "https://api.v0.dev" */
	readonly baseUrl?: string;
	/** Bearer token for authentication */
	readonly token?: string;
	/** Custom fetch implementation */
	readonly fetchImpl?: typeof fetch;
	/** Additional headers to include in all requests */
	readonly headers?: Record<string, string>;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * API error with status code and error payload.
 * Uses Effect's Data.TaggedError for excellent pattern matching support.
 *
 * @example
 * ```ts
 * import { ApiError } from "v0-api/effect";
 * import { Effect, Match } from "effect";
 *
 * const handleError = Match.type<ApiError>().pipe(
 *   Match.when({ status: 401 }, () => "Unauthorized"),
 *   Match.when({ status: 404 }, () => "Not found"),
 *   Match.orElse(() => "Unknown error")
 * );
 * ```
 */
export class ApiError extends Data.TaggedError("ApiError")<{
	readonly status: number;
	readonly error: unknown;
	readonly message?: string;
}> {
	override get message(): string {
		if (this.error && typeof this.error === "object" && "message" in this.error) {
			return String((this.error as { message: unknown }).message);
		}
		return `API Error: ${this.status}`;
	}
}

/**
 * Network error for fetch failures.
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
 * Request options for the API client.
 */
export interface ApiClientRequest {
	readonly method: string;
	readonly url: string;
	readonly body?: unknown;
	readonly headers?: Record<string, string>;
	readonly signal?: AbortSignal;
}

/**
 * API client interface for making HTTP requests.
 */
export interface ApiClientService {
	/**
	 * Make an HTTP request to the API.
	 */
	readonly request: <T>(options: ApiClientRequest) => Effect.Effect<T, ApiError | NetworkError>;
}

/**
 * Effect Context tag for the API client service.
 *
 * @example
 * ```ts
 * import { ApiClient, makeApiClientLive } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const client = yield* ApiClient;
 *   return yield* client.request({ method: "GET", url: "/v1/generate" });
 * });
 *
 * const result = await program.pipe(
 *   Effect.provide(makeApiClientLive({ token: "your-token" })),
 *   Effect.runPromise
 * );
 * ```
 */
export class ApiClient extends Context.Tag("ApiClient")<ApiClient, ApiClientService>() {}

// ============================================================================
// API Client Implementation
// ============================================================================

const DEFAULT_BASE_URL = "https://api.v0.dev";

/**
 * Create a live implementation of the API client.
 *
 * @param config - Configuration for the API client
 * @returns A Layer that provides the ApiClient service
 *
 * @example
 * ```ts
 * import { makeApiClientLive, ApiService } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * // Create the client layer
 * const ApiLayer = makeApiClientLive({
 *   token: process.env.V0_TOKEN,
 *   baseUrl: "https://api.v0.dev",
 * });
 *
 * // Use the API
 * const program = ApiService.generate.createGeneration({ body: { ... } });
 *
 * // Run with the layer
 * const result = await program.pipe(
 *   Effect.provide(ApiLayer),
 *   Effect.runPromise
 * );
 * ```
 */
export const makeApiClientLive = (config: ApiClientConfig = {}): Layer.Layer<ApiClient> => {
	const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
	const fetchFn = config.fetchImpl ?? fetch;

	return Layer.succeed(
		ApiClient,
		ApiClient.of({
			request: <T>(options: ApiClientRequest): Effect.Effect<T, ApiError | NetworkError> =>
				Effect.tryPromise({
					try: async () => {
						const headers: HeadersInit = {
							"Content-Type": "application/json",
							...config.headers,
							...options.headers,
						};

						if (config.token) {
							(headers as Record<string, string>)["Authorization"] = `Bearer ${config.token}`;
						}

						// Handle multipart/form-data
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

						const fullUrl = `${baseUrl}${options.url}`;

						const response = await fetchFn(fullUrl, {
							method: options.method,
							headers,
							body,
							signal: options.signal,
						});

						if (!response.ok) {
							let errorPayload: unknown;
							try {
								errorPayload = await response.json();
							} catch {
								errorPayload = { message: await response.text() };
							}
							throw new ApiError({
								status: response.status,
								error: errorPayload,
							});
						}

						const contentType = response.headers.get("content-type");
						if (contentType?.includes("application/json")) {
							return (await response.json()) as T;
						}
						return (await response.text()) as unknown as T;
					},
					catch: (error) => {
						if (error instanceof ApiError) {
							return error;
						}
						return new NetworkError({ cause: error });
					},
				}),
		}),
	);
};

/**
 * Default API client layer (requires V0_TOKEN environment variable).
 * Useful for quick testing or when configuration is handled via environment.
 *
 * @example
 * ```ts
 * import { ApiClientLive, ApiService } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * // Reads V0_TOKEN from environment
 * const result = await ApiService.generate.createGeneration({ body: { ... } }).pipe(
 *   Effect.provide(ApiClientLive),
 *   Effect.runPromise
 * );
 * ```
 */
export const ApiClientLive: Layer.Layer<ApiClient> = Layer.sync(ApiClient, () =>
	ApiClient.of({
		request: <T>(options: ApiClientRequest): Effect.Effect<T, ApiError | NetworkError> => {
			const token = typeof process !== "undefined" ? process.env?.["V0_TOKEN"] : undefined;
			return makeApiClientLive({ token }).pipe(
				Layer.build,
				Effect.map((context) => Context.get(context, ApiClient)),
				Effect.flatMap((client) => client.request<T>(options)),
				Effect.scoped,
			);
		},
	}),
);

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Run an Effect with the API client configured.
 * Convenience function for one-off API calls.
 *
 * @example
 * ```ts
 * import { runWithClient, ApiService } from "v0-api/effect";
 *
 * const result = await runWithClient(
 *   { token: "your-token" },
 *   ApiService.generate.createGeneration({ body: { ... } })
 * );
 * ```
 */
export const runWithClient = <A, E>(
	config: ApiClientConfig,
	effect: Effect.Effect<A, E, ApiClient>,
): Promise<A> => {
	return effect.pipe(Effect.provide(makeApiClientLive(config)), Effect.runPromise);
};

/**
 * Create a scoped API client for making multiple requests.
 * Returns an object with methods that automatically use the configured client.
 *
 * @example
 * ```ts
 * import { createClient, ApiService } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * const client = createClient({ token: "your-token" });
 *
 * // All operations automatically use the configured client
 * const result = await client.run(ApiService.generate.createGeneration({ body: { ... } }));
 * ```
 */
export const createClient = (config: ApiClientConfig) => {
	const layer = makeApiClientLive(config);

	return {
		/**
		 * Run an Effect with this client's configuration.
		 */
		run: <A, E>(effect: Effect.Effect<A, E, ApiClient>): Promise<A> =>
			effect.pipe(Effect.provide(layer), Effect.runPromise),

		/**
		 * Run an Effect with this client's configuration, returning an Exit.
		 */
		runExit: <A, E>(effect: Effect.Effect<A, E, ApiClient>) =>
			effect.pipe(Effect.provide(layer), Effect.runPromiseExit),

		/**
		 * Get the Layer for this client (for advanced composition).
		 */
		layer,
	};
};
