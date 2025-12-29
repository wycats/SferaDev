import type { FetchImpl } from "./fetch";
import { compactObject } from "./lang";

const baseUrl = "https://api.netlify.com";

export type FetcherConfig = {
	token?: string | null;
	fetchImpl?: FetchImpl;
	basePath?: string;
	headers?: Record<string, any>;
};

export type ErrorWrapper<TError> = TError | { status: "unknown"; payload: string };

export type FetcherOptions<TBody, THeaders, TQueryParams, TPathParams> = {
	url: string;
	method: string;
	body?: TBody | undefined;
	headers?: THeaders | undefined;
	queryParams?: TQueryParams | undefined;
	pathParams?: TPathParams | undefined;
	signal?: AbortSignal | undefined;
} & FetcherConfig;

export async function client<TData, TError, TBody, THeaders, TQueryParams, TPathParams>({
	url,
	method,
	body,
	headers,
	pathParams,
	queryParams,
	signal,
	token = null,
	basePath = "/api/v1",
	fetchImpl = fetch as FetchImpl,
}: FetcherOptions<TBody, THeaders, TQueryParams, TPathParams>): Promise<TData> {
	try {
		const requestHeaders: HeadersInit = compactObject({
			"Content-Type": "application/json",
			Authorization: token ? `Bearer ${token}` : undefined,
			...headers,
		});

		if (requestHeaders["Content-Type"]?.toLowerCase().includes("multipart/form-data")) {
			delete requestHeaders["Content-Type"];
		}

		const payload =
			body instanceof FormData
				? body
				: requestHeaders["Content-Type"] === "application/json"
					? JSON.stringify(body)
					: (body as unknown as string);

		const fullUrl = `${baseUrl}${basePath}${resolveUrl(url, queryParams, pathParams)}`;

		const response = await fetchImpl(fullUrl, {
			signal,
			method: method.toUpperCase(),
			body: payload,
			headers: requestHeaders,
		});

		if (!response.ok) {
			let error: ErrorWrapper<TError>;
			try {
				error = await response.json();
			} catch (e) {
				error = {
					status: "unknown" as const,
					payload: e instanceof Error ? `Unexpected error (${e.message})` : "Unexpected error",
				};
			}
			throw error;
		}

		if (response.headers?.get("content-type")?.includes("json")) {
			return await response.json();
		} else {
			return (await response.text()) as unknown as TData;
		}
	} catch (e) {
		const errorObject: Error = {
			name: "unknown" as const,
			message: e instanceof Error ? `Network error (${e.message})` : "Network error",
			stack: e as string,
		};
		throw errorObject;
	}
}

const resolveUrl = (url: string, queryParams: any = {}, pathParams: any = {}) => {
	let query = new URLSearchParams(queryParams).toString();
	if (query) query = `?${query}`;
	return url.replace(/\{\w*\}/g, (key) => pathParams[key.slice(1, -1)] ?? "") + query;
};

export default client;
