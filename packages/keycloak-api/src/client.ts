import type { operationsByPath as accountOperationsByPath } from "./account/generated/components";
import type { operationsByPath as adminOperationsByPath } from "./admin/generated/components";
import type { FetchImpl } from "./utils/fetch";
import fetchFn, { type FetcherConfig } from "./utils/fetcher";

export interface KeycloakAdminApiOptions {
	baseUrl: string;
	token: string | null;
	fetch?: FetchImpl;
}

export interface KeycloakAccountApiOptions {
	baseUrl: string;
	realm: string;
	token: string | null;
	fetch?: FetchImpl;
}

type AdminRequestEndpointParams<T extends keyof typeof adminOperationsByPath> = Omit<
	Parameters<(typeof adminOperationsByPath)[T]>[0],
	keyof FetcherConfig
>;

type AdminRequestEndpointResult<T extends keyof typeof adminOperationsByPath> = ReturnType<
	(typeof adminOperationsByPath)[T]
>;

type AccountRequestEndpointParams<T extends keyof typeof accountOperationsByPath> = Omit<
	Parameters<(typeof accountOperationsByPath)[T]>[0],
	keyof FetcherConfig
>;

type AccountRequestEndpointResult<T extends keyof typeof accountOperationsByPath> = ReturnType<
	(typeof accountOperationsByPath)[T]
>;

export class KeycloakAdminApi {
	#baseUrl: string;
	#token: string | null;
	#fetch: FetchImpl;

	constructor(options: KeycloakAdminApiOptions) {
		this.#baseUrl = options.baseUrl;
		this.#token = options.token;

		this.#fetch = options.fetch || (fetch as FetchImpl);
		if (!this.#fetch) throw new Error("Fetch is required");
	}

	public async request<Endpoint extends keyof typeof adminOperationsByPath>(
		endpoint: Endpoint,
		params: AdminRequestEndpointParams<Endpoint>,
	) {
		const [method = "", url = ""] = endpoint.split(" ");
		const extraParams = (params || {}) as Record<string, unknown>;

		const result = await fetchFn({
			...extraParams,
			method,
			url,
			baseUrl: this.#baseUrl,
			token: this.#token,
			fetchImpl: this.#fetch,
		});
		return result as AdminRequestEndpointResult<Endpoint>;
	}
}

export class KeycloakAccountApi {
	#baseUrl: string;
	#realm: string;
	#token: string | null;
	#fetch: FetchImpl;

	constructor(options: KeycloakAccountApiOptions) {
		this.#baseUrl = options.baseUrl;
		this.#realm = options.realm;
		this.#token = options.token;

		this.#fetch = options.fetch || (fetch as FetchImpl);
		if (!this.#fetch) throw new Error("Fetch is required");
	}

	public async request<Endpoint extends keyof typeof accountOperationsByPath>(
		endpoint: Endpoint,
		params: AccountRequestEndpointParams<Endpoint>,
	) {
		const baseUrl = `${this.#baseUrl}/realms/${this.#realm}`;
		const [method = "", url = ""] = endpoint.split(" ");
		const extraParams = (params || {}) as Record<string, unknown>;

		const result = await fetchFn({
			...extraParams,
			method,
			url,
			baseUrl,
			token: this.#token,
			fetchImpl: this.#fetch,
		});
		return result as AccountRequestEndpointResult<Endpoint>;
	}
}
