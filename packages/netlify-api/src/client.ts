import { type operationsByPath, operationsByTag, type tagDictionary } from "./generated/components";
import type { FetchImpl } from "./utils/fetch";
import fetchFn, { type FetcherConfig } from "./utils/fetcher";
import type { RequiredKeys } from "./utils/types";

export interface NetlifyApiOptions {
	token: string;
	fetch?: FetchImpl;
	basePath?: string;
}

export type ApiClient = {
	[Tag in keyof typeof operationsByTag]: {
		[Method in keyof (typeof operationsByTag)[Tag]]: (typeof operationsByTag)[Tag][Method] extends infer Operation extends
			(...args: any) => any
			? Omit<Parameters<Operation>[0], keyof FetcherConfig> extends infer Params
				? RequiredKeys<Params> extends never
					? (params?: Params) => ReturnType<Operation>
					: (params: Params) => ReturnType<Operation>
				: never
			: never;
	};
};

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export type ApiOperation = {
	[Tag in keyof typeof operationsByTag]: keyof (typeof operationsByTag)[Tag] extends string
		? `${Tag}.${keyof (typeof operationsByTag)[Tag]}`
		: never;
}[keyof typeof operationsByTag];

export type ApiOperationByMethod<Method extends HttpMethod> = {
	[Tag in keyof typeof tagDictionary]: {
		[TagMethod in keyof (typeof tagDictionary)[Tag]]: TagMethod extends Method
			? (typeof tagDictionary)[Tag][TagMethod] extends readonly any[]
				? `${Tag}.${(typeof tagDictionary)[Tag][TagMethod][number]}`
				: never
			: never;
	}[keyof (typeof tagDictionary)[Tag]];
}[keyof typeof tagDictionary];

export type ApiOperationParams<T extends ApiOperation> = T extends `${infer Tag}.${infer Operation}`
	? Tag extends keyof typeof operationsByTag
		? Operation extends keyof (typeof operationsByTag)[Tag]
			? (typeof operationsByTag)[Tag][Operation] extends infer Operation extends (
					...args: any
				) => any
				? Omit<Parameters<Operation>[0], keyof FetcherConfig>
				: never
			: never
		: never
	: never;

export type ApiOperationResult<T extends ApiOperation> = T extends `${infer Tag}.${infer Operation}`
	? Tag extends keyof typeof operationsByTag
		? Operation extends keyof (typeof operationsByTag)[Tag]
			? (typeof operationsByTag)[Tag][Operation] extends (...args: any) => any
				? Awaited<ReturnType<(typeof operationsByTag)[Tag][Operation]>>
				: never
			: never
		: never
	: never;

type RequestEndpointParams<T extends keyof typeof operationsByPath> = Omit<
	Parameters<(typeof operationsByPath)[T]>[0],
	keyof FetcherConfig
>;

type RequestEndpointResult<T extends keyof typeof operationsByPath> = ReturnType<
	(typeof operationsByPath)[T]
>;

export class NetlifyApi {
	#token: string;
	#fetch: FetchImpl;
	#basePath: string;

	constructor(options: NetlifyApiOptions) {
		this.#token = options.token;
		if (!options.token) throw new Error("Token is required");

		this.#fetch = options.fetch || (fetch as FetchImpl);
		if (!this.#fetch) throw new Error("Fetch is required");

		this.#basePath = options.basePath || "/api/v1";
	}

	get api() {
		const getConfig = async (): Promise<FetcherConfig> => ({
			token: this.#token,
			basePath: this.#basePath,
			fetchImpl: this.#fetch,
		});

		return new Proxy(
			{},
			{
				get: (_target, namespace: keyof typeof operationsByTag) => {
					if (operationsByTag[namespace] === undefined) {
						return undefined;
					}

					return new Proxy(
						{},
						{
							get: (
								_target,
								operation: keyof (typeof operationsByTag)[keyof typeof operationsByTag],
							) => {
								if (operationsByTag[namespace][operation] === undefined) {
									return undefined;
								}

								const method = operationsByTag[namespace][operation] as any;

								return async (params: Record<string, unknown>) => {
									return await method({ ...params, config: await getConfig() });
								};
							},
						},
					);
				},
			},
		) as ApiClient;
	}

	get auth() {
		return {
			refreshToken: async ({
				refreshToken,
				authToken,
				clientId,
				clientSecret,
			}: RefreshTokenOptions): Promise<RefreshTokenResult> => {
				const result: {
					token_type: string;
					access_token: string;
					refresh_token: string;
					scope: string;
					created_at: number;
				} = await fetchFn({
					method: "POST",
					url: "/oauth/token",
					body: {
						grant_type: "refresh_token",
						refresh_token: refreshToken,
						client_id: clientId,
						client_secret: clientSecret,
					},
					token: authToken || this.#token,
					fetchImpl: this.#fetch,
					basePath: "",
				});

				return {
					tokenType: result.token_type,
					accessToken: result.access_token,
					refreshToken: result.refresh_token,
					scope: result.scope,
					createdAt: result.created_at,
				};
			},
		};
	}

	public async request<Endpoint extends keyof typeof operationsByPath>(
		endpoint: Endpoint,
		params: RequestEndpointParams<Endpoint>,
	) {
		const [method = "", url = ""] = endpoint.split(" ");
		const extraParams = (params || {}) as Record<string, unknown>;

		const result = await fetchFn({
			...extraParams,
			method,
			url,
			token: this.#token,
			fetchImpl: this.#fetch,
			basePath: this.#basePath,
		});

		return result as RequestEndpointResult<Endpoint>;
	}
}

type RefreshTokenOptions = {
	refreshToken: string;
	authToken?: string;
	clientId: string;
	clientSecret: string;
};

type RefreshTokenResult = {
	tokenType: string;
	accessToken: string;
	refreshToken: string;
	scope: string;
	createdAt: number;
};
