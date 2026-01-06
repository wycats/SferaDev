import { Context, Data, Effect, Layer, Schema } from "effect";

// ============================================================================
// Configuration Schema
// ============================================================================

/**
 * Schema for API client configuration.
 * Provides runtime validation and type inference.
 *
 * @example
 * ```ts
 * import { ApiClientConfig } from "v0-api/effect";
 * import { Schema } from "effect";
 *
 * // Parse and validate config
 * const config = Schema.decodeUnknownSync(ApiClientConfig)({
 *   token: "my-token",
 *   baseUrl: "https://api.v0.dev"
 * });
 * ```
 */
export const ApiClientConfig = Schema.Struct({
	/** Base URL for the API. Defaults to "https://api.v0.dev" */
	baseUrl: Schema.optionalWith(Schema.String, { default: () => "https://api.v0.dev" }),
	/** Bearer token for authentication */
	token: Schema.optional(Schema.String),
	/** Additional headers to include in all requests */
	headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});

export type ApiClientConfig = typeof ApiClientConfig.Type;

/**
 * Schema for API client request options.
 */
export const ApiClientRequest = Schema.Struct({
	method: Schema.String,
	url: Schema.String,
	body: Schema.optional(Schema.Unknown),
	headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
});

export type ApiClientRequest = typeof ApiClientRequest.Type;

// ============================================================================
// Error Types
// ============================================================================

/**
 * API error with status code and error payload.
 * Uses Effect's Data.TaggedError for pattern matching support.
 *
 * @example
 * ```ts
 * import { ApiError, ApiService, makeApiClientLive } from "v0-api/effect";
 * import { Effect, Match } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* ApiService.generations.createGeneration({
 *     body: { prompt: "A landing page" }
 *   }).pipe(
 *     Effect.catchTag("ApiError", (error) =>
 *       Effect.gen(function* () {
 *         const message = Match.value(error).pipe(
 *           Match.when({ status: 401 }, () => "Please check your API token"),
 *           Match.when({ status: 403 }, () => "You don't have access"),
 *           Match.when({ status: 429 }, () => "Rate limited, please retry later"),
 *           Match.orElse(() => `API error: ${error.status}`)
 *         );
 *         console.error(message);
 *         return yield* Effect.fail(error);
 *       })
 *     )
 *   );
 *   return result;
 * });
 * ```
 */
export class ApiError extends Data.TaggedError("ApiError")<{
	readonly status: number;
	readonly error: unknown;
}> {
	get message(): string {
		if (this.error && typeof this.error === "object" && "message" in this.error) {
			return String((this.error as { message: unknown }).message);
		}
		return `API Error: ${this.status}`;
	}
}

/**
 * Network error for fetch failures (timeouts, DNS errors, etc).
 *
 * @example
 * ```ts
 * import { NetworkError, ApiService } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* ApiService.generations.createGeneration({
 *     body: { prompt: "A landing page" }
 *   }).pipe(
 *     Effect.catchTag("NetworkError", (error) =>
 *       Effect.gen(function* () {
 *         console.error("Network failed:", error.message);
 *         return yield* Effect.fail(error);
 *       })
 *     )
 *   );
 *   return result;
 * });
 * ```
 */
export class NetworkError extends Data.TaggedError("NetworkError")<{
	readonly cause: unknown;
}> {
	get message(): string {
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
	readonly request: <T>(options: ApiClientRequest) => Effect.Effect<T, ApiError | NetworkError>;
};

/**
 * Effect Context tag for the API client service.
 * Use this with Effect.gen for elegant async/await-like syntax.
 *
 * @example
 * ```ts
 * import { ApiClient, makeApiClientLive } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * // Using Effect.gen for async generator syntax
 * const program = Effect.gen(function* () {
 *   const client = yield* ApiClient;
 *
 *   // Make a request
 *   const generation = yield* client.request({
 *     method: "POST",
 *     url: "/v1/generate",
 *     body: { prompt: "A landing page for a SaaS product" }
 *   });
 *
 *   console.log("Generated:", generation);
 *   return generation;
 * });
 *
 * // Run the program
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
 * @param config - Configuration for the API client (validated at runtime)
 * @returns A Layer that provides the ApiClient service
 *
 * @example
 * ```ts
 * import { ApiService, makeApiClientLive } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * // Create the client layer
 * const ApiLayer = makeApiClientLive({
 *   token: process.env.V0_TOKEN,
 * });
 *
 * // Generate UI with async generators
 * const program = Effect.gen(function* () {
 *   // Create a generation
 *   const generation = yield* ApiService.generations.createGeneration({
 *     body: {
 *       prompt: "A modern dashboard with charts and statistics",
 *       model: "v0-1.0-md"
 *     }
 *   });
 *
 *   console.log("Generation started:", generation.id);
 *
 *   // Poll for completion (example pattern)
 *   let status = generation;
 *   while (status.status === "pending") {
 *     yield* Effect.sleep("2 seconds");
 *     status = yield* ApiService.generations.getGeneration({
 *       pathParams: { generationId: generation.id }
 *     });
 *   }
 *
 *   return status;
 * });
 *
 * // Run with the layer
 * const result = await program.pipe(
 *   Effect.provide(ApiLayer),
 *   Effect.runPromise
 * );
 * ```
 */
export const makeApiClientLive = (
	config: Partial<ApiClientConfig> = {},
): Layer.Layer<ApiClient> => {
	const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
	const fetchFn = fetch;

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
							(headers as Record<string, string>).Authorization = `Bearer ${config.token}`;
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

						const fullUrl = `${baseUrl}${options.url}`;

						const response = await fetchFn(fullUrl, {
							method: options.method,
							headers,
							body,
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
 * Default API client layer using V0_TOKEN environment variable.
 *
 * @example
 * ```ts
 * import { ApiClientLive, ApiService } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * // Quick one-liner using env var
 * const program = Effect.gen(function* () {
 *   const generation = yield* ApiService.generations.createGeneration({
 *     body: { prompt: "A contact form" }
 *   });
 *   return generation;
 * });
 *
 * const result = await program.pipe(
 *   Effect.provide(ApiClientLive),
 *   Effect.runPromise
 * );
 * ```
 */
export const ApiClientLive: Layer.Layer<ApiClient> = Layer.sync(ApiClient, () =>
	ApiClient.of({
		request: <T>(options: ApiClientRequest): Effect.Effect<T, ApiError | NetworkError> => {
			const token = typeof process !== "undefined" ? process.env?.V0_TOKEN : undefined;
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
 * Run an Effect program with the API client configured.
 * Best for one-off API calls or scripts.
 *
 * @example
 * ```ts
 * import { runWithClient, ApiService } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * // Simple one-off call
 * const generation = await runWithClient(
 *   { token: "your-token" },
 *   ApiService.generations.createGeneration({
 *     body: { prompt: "A pricing page" }
 *   })
 * );
 *
 * // Complex program with generators
 * const result = await runWithClient(
 *   { token: "your-token" },
 *   Effect.gen(function* () {
 *     const gen1 = yield* ApiService.generations.createGeneration({
 *       body: { prompt: "A hero section" }
 *     });
 *     const gen2 = yield* ApiService.generations.createGeneration({
 *       body: { prompt: "A features section" }
 *     });
 *     return { hero: gen1, features: gen2 };
 *   })
 * );
 * ```
 */
export const runWithClient = <A, E>(
	config: Partial<ApiClientConfig>,
	effect: Effect.Effect<A, E, ApiClient>,
): Promise<A> => {
	return effect.pipe(Effect.provide(makeApiClientLive(config)), Effect.runPromise);
};

/**
 * Create a reusable API client for making multiple requests.
 * Ideal for applications that need to make many API calls.
 *
 * @example
 * ```ts
 * import { createClient, ApiService } from "v0-api/effect";
 * import { Effect } from "effect";
 *
 * // Create client once
 * const v0 = createClient({ token: process.env.V0_TOKEN });
 *
 * // Use throughout your application
 * async function generateComponents() {
 *   return v0.run(
 *     Effect.gen(function* () {
 *       // Generate multiple components in parallel
 *       const [header, sidebar, footer] = yield* Effect.all([
 *         ApiService.generations.createGeneration({
 *           body: { prompt: "A navigation header" }
 *         }),
 *         ApiService.generations.createGeneration({
 *           body: { prompt: "A sidebar menu" }
 *         }),
 *         ApiService.generations.createGeneration({
 *           body: { prompt: "A footer with links" }
 *         }),
 *       ]);
 *
 *       return { header, sidebar, footer };
 *     })
 *   );
 * }
 *
 * // With retry logic using generators
 * async function generateWithRetry(prompt: string) {
 *   return v0.run(
 *     Effect.gen(function* () {
 *       const result = yield* ApiService.generations.createGeneration({
 *         body: { prompt }
 *       }).pipe(
 *         Effect.retry({ times: 3 }),
 *         Effect.catchTag("ApiError", (error) =>
 *           Effect.gen(function* () {
 *             if (error.status === 429) {
 *               yield* Effect.sleep("5 seconds");
 *               return yield* ApiService.generations.createGeneration({
 *                 body: { prompt }
 *               });
 *             }
 *             return yield* Effect.fail(error);
 *           })
 *         )
 *       );
 *       return result;
 *     })
 *   );
 * }
 * ```
 */
export const createClient = (config: Partial<ApiClientConfig>) => {
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
		 *
		 * @example
		 * ```ts
		 * const v0 = createClient({ token: "..." });
		 *
		 * const exit = await v0.runExit(
		 *   Effect.gen(function* () {
		 *     return yield* ApiService.generations.createGeneration({
		 *       body: { prompt: "A button component" }
		 *     });
		 *   })
		 * );
		 *
		 * if (Exit.isSuccess(exit)) {
		 *   console.log("Generated:", exit.value);
		 * } else {
		 *   console.error("Failed:", exit.cause);
		 * }
		 * ```
		 */
		runExit: <A, E>(effect: Effect.Effect<A, E, ApiClient>) =>
			effect.pipe(Effect.provide(layer), Effect.runPromiseExit),

		/**
		 * Get the Layer for advanced composition scenarios.
		 *
		 * @example
		 * ```ts
		 * const v0 = createClient({ token: "..." });
		 *
		 * // Compose with other layers
		 * const AppLayer = Layer.merge(v0.layer, DatabaseLayer);
		 * ```
		 */
		layer,
	};
};
