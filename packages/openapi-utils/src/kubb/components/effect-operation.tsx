import { URLPath } from "@kubb/core/utils";
import { isOptional, type Operation } from "@kubb/oas";
import type { PluginClient } from "@kubb/plugin-client";
import type { OperationSchemas } from "@kubb/plugin-oas";
import { getComments, getPathParams } from "@kubb/plugin-oas/utils";
import { File, Function as FunctionDeclaration, FunctionParams } from "@kubb/react-fabric";

export function getEffectParams({
	paramsCasing,
	typeSchemas,
}: {
	paramsCasing: PluginClient["resolvedOptions"]["paramsCasing"];
	typeSchemas: OperationSchemas;
}) {
	const hasAnyParams =
		typeSchemas.pathParams?.name ||
		typeSchemas.request?.name ||
		typeSchemas.queryParams?.name ||
		typeSchemas.headerParams?.name;

	if (!hasAnyParams) {
		return FunctionParams.factory({});
	}

	return FunctionParams.factory({
		data: {
			mode: "object",
			children: {
				pathParams: typeSchemas.pathParams?.name
					? {
							type: typeSchemas.pathParams?.name,
							mode: "object",
							children: getPathParams(typeSchemas.pathParams, {
								typed: true,
								casing: paramsCasing,
							}),
							optional: isOptional(typeSchemas.pathParams?.schema),
						}
					: undefined,
				body: typeSchemas.request?.name
					? {
							type: typeSchemas.request?.name,
							optional: isOptional(typeSchemas.request?.schema),
						}
					: undefined,
				queryParams: typeSchemas.queryParams?.name
					? {
							type: typeSchemas.queryParams?.name,
							optional: isOptional(typeSchemas.queryParams?.schema),
						}
					: undefined,
				headers: typeSchemas.headerParams?.name
					? {
							type: typeSchemas.headerParams?.name,
							optional: isOptional(typeSchemas.headerParams?.schema),
						}
					: undefined,
			},
		},
	});
}

export function EffectOperation({
	name,
	isExportable = true,
	isIndexable = true,
	typeSchemas,
	paramsCasing,
	operation,
}: {
	name: string;
	isExportable?: boolean;
	isIndexable?: boolean;
	typeSchemas: OperationSchemas;
	paramsCasing: PluginClient["resolvedOptions"]["paramsCasing"];
	operation: Operation;
}) {
	const path = new URLPath(operation.path, { casing: paramsCasing });
	const contentType = operation.getContentType();
	const isFormData = contentType === "multipart/form-data";
	const method = operation.method.toUpperCase();

	const TError = typeSchemas.errors?.map((item) => item.name).join(" | ") || "never";
	const TResponse = typeSchemas.response.name;

	const params = getEffectParams({ paramsCasing, typeSchemas });

	const hasPathParams = !!typeSchemas.pathParams?.name;
	const hasQueryParams = !!typeSchemas.queryParams?.name;
	const hasBody = !!typeSchemas.request?.name;
	const hasHeaders = !!typeSchemas.headerParams?.name;

	const hasAnyParams = hasPathParams || hasQueryParams || hasBody || hasHeaders;

	// Build the path template with interpolation
	const pathTemplate = path.template;

	// Build headers object
	const headersEntries = [
		contentType !== "application/json" ? `"Content-Type": "${contentType}"` : null,
		hasHeaders ? "...headers" : null,
	].filter(Boolean);

	const headersObject = headersEntries.length > 0 ? `{ ${headersEntries.join(", ")} }` : "{}";

	// Generate the Effect function body
	const functionBody = `
		return Effect.gen(function* () {
			const client = yield* ApiClient;
			${hasPathParams ? `const { ${Object.keys(typeSchemas.pathParams?.schema?.properties || {}).join(", ")} } = pathParams ?? {};` : ""}
			${
				hasPathParams
					? Object.keys(typeSchemas.pathParams?.schema?.properties || {})
							.map(
								(key) => `
			if (${key} === undefined) {
				return yield* Effect.fail(new ApiError({
					status: 400,
					error: { message: "Missing required path parameter: ${key}" }
				}));
			}`,
							)
							.join("")
					: ""
			}

			const url = \`${pathTemplate}\`;
			${hasQueryParams ? "const searchParams = queryParams ? new URLSearchParams(Object.entries(queryParams).filter(([_, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : '';" : ""}
			const fullUrl = ${hasQueryParams ? '`${url}${searchParams ? `?${searchParams}` : ""}`' : "url"};

			${
				isFormData
					? `
			const formData = new FormData();
			if (body) {
				Object.entries(body).forEach(([key, value]) => {
					if (typeof value === "string" || value instanceof Blob) {
						formData.append(key, value);
					}
				});
			}`
					: ""
			}

			const response = yield* client.request({
				method: "${method}",
				url: fullUrl,
				${hasBody ? `body: ${isFormData ? "formData" : "body"},` : ""}
				headers: ${headersObject},
			});

			return response as ${TResponse};
		});`;

	return (
		<File.Source name={name} isExportable={isExportable} isIndexable={isIndexable}>
			<FunctionDeclaration
				name={name}
				export={isExportable}
				params={params.toConstructor()}
				JSDoc={{
					comments: getComments(operation),
				}}
				returnType={`Effect.Effect<${TResponse}, ApiError | ${TError}, ApiClient>`}
			>
				{functionBody}
			</FunctionDeclaration>
		</File.Source>
	);
}

EffectOperation.getParams = getEffectParams;
