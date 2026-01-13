import { usePluginManager } from "@kubb/core/hooks";
import { camelCase, pascalCase } from "@kubb/core/transformers";
import type { PluginClient } from "@kubb/plugin-client";
import { createReactGenerator } from "@kubb/plugin-oas/generators";
import { useOas, useOperationManager } from "@kubb/plugin-oas/hooks";
import { getBanner, getFooter } from "@kubb/plugin-oas/utils";
import { pluginTsName } from "@kubb/plugin-ts";
import { File } from "@kubb/react-fabric";
import { getEffectParams } from "../components/effect-operation";

export const effectServiceGenerator: ReturnType<typeof createReactGenerator<PluginClient>> =
	createReactGenerator<PluginClient>({
		name: "effect-service",
		Operations({ operations, plugin, generator }) {
			const pluginManager = usePluginManager();
			const { options } = plugin;
			const oas = useOas();
			const { getFile, getName, getSchemas } = useOperationManager(generator);

			const fileName = "effect";
			const file = pluginManager.getFile({ name: fileName, extname: ".ts", pluginKey: plugin.key });

			// Group operations by tag
			const operationsByTag = new Map<string, typeof operations>();
			for (const operation of operations) {
				const tags = operation.getTags() || [{ name: "default" }];
				const primaryTag = tags[0]?.name || "default";
				const tagKey = camelCase(primaryTag);

				if (!operationsByTag.has(tagKey)) {
					operationsByTag.set(tagKey, []);
				}
				operationsByTag.get(tagKey)?.push(operation);
			}

			// Map operations with their metadata
			const operationsMapped = operations.map((operation) => {
				const tags = operation.getTags() || [{ name: "default" }];
				return {
					operation,
					tag: camelCase(tags[0]?.name || "default"),
					effect: {
						name: getName(operation, { type: "function" }),
						file: getFile(operation),
					},
					type: {
						file: getFile(operation, { pluginKey: [pluginTsName] }),
						schemas: getSchemas(operation, { pluginKey: [pluginTsName], type: "type" }),
					},
				};
			});

			// Generate imports for all operations
			const imports = operationsMapped.map(({ effect }) => (
				<File.Import
					key={effect.name}
					name={[effect.name]}
					root={file.path}
					path={effect.file.path}
				/>
			));

			// Generate type imports
			const typeImports = operationsMapped.flatMap(({ type, effect }) => {
				const names = [
					type.schemas.request?.name,
					type.schemas.response.name,
					type.schemas.pathParams?.name,
					type.schemas.queryParams?.name,
					type.schemas.headerParams?.name,
					...(type.schemas.statusCodes?.map((item) => item.name) || []),
				].filter(Boolean) as string[];

				return names.length > 0 ? (
					<File.Import
						key={`types-${effect.name}`}
						name={names}
						root={file.path}
						path={type.file.path}
						isTypeOnly
					/>
				) : null;
			});

			// Build the service object by tag
			const tagServices = Array.from(operationsByTag.entries())
				.map(([tag, tagOperations]) => {
					const serviceName = `${pascalCase(tag)}Service`;
					const methods = tagOperations
						.map((operation) => {
							const opMeta = operationsMapped.find((o) => o.operation === operation);
							if (!opMeta) return null;
							const params = getEffectParams({
								paramsCasing: options.paramsCasing,
								typeSchemas: opMeta.type.schemas,
							});
							const paramsStr = params.toConstructor();
							const callParamsStr = params.toCall();
							return `    ${opMeta.effect.name}: (${paramsStr}) => ${opMeta.effect.name}(${callParamsStr})`;
						})
						.filter((m): m is string => m !== null)
						.join(",\n");

					return `export const ${serviceName} = {
${methods}
} as const;`;
				})
				.join("\n\n");

			// Build the unified API service
			const apiServiceMethods = Array.from(operationsByTag.entries())
				.map(([tag]) => {
					const serviceName = `${pascalCase(tag)}Service`;
					return `  ${tag}: ${serviceName}`;
				})
				.join(",\n");

			// Build the service by path pattern (for direct endpoint access)
			const operationsByPath = operationsMapped
				.map(({ operation, effect, type }) => {
					const method = operation.method.toUpperCase();
					const path = operation.path;
					const key = `${method} ${path}`;
					const params = getEffectParams({
						paramsCasing: options.paramsCasing,
						typeSchemas: type.schemas,
					});
					return { key, name: effect.name, params };
				})
				.sort((a, b) => a.key.localeCompare(b.key));

			const pathsType = operationsByPath
				.map(({ key, name }) => `  "${key}": typeof ${name}`)
				.join(";\n");

			const pathsObject = operationsByPath
				.map(({ key, name }) => `  "${key}": ${name}`)
				.join(",\n");

			// Extract package name for JSDoc examples from output directory
			const outputPath = options.output?.path || "";
			const packageName = outputPath.includes("vercel-api-js")
				? "vercel-api-js"
				: outputPath.includes("v0-api")
					? "v0-api"
					: "your-package";

			return (
				<File
					baseName={file.baseName}
					path={file.path}
					meta={file.meta}
					// @ts-expect-error conflict with react-fabric types
					banner={getBanner({ oas, output: options.output, config: pluginManager.config })}
					footer={getFooter({ oas, output: options.output })}
				>
					<File.Import name={["Effect", "Context", "Layer"]} path="effect" />
					<File.Import
						name={[
							"ApiClient",
							"ApiError",
							"ValidationError",
							"NetworkError",
							"makeApiClientLive",
							"makeApiClientFromEnv",
							"createClient",
							"runWithClient",
							"serializeQueryParams",
						]}
						path="@sferadev/openapi-utils/effect"
					/>
					{imports}
					{typeImports}

					<File.Source name={fileName} isExportable isIndexable>
						{`
// Re-export core types for convenience
export { ApiClient, ApiError, ValidationError, NetworkError, makeApiClientLive, makeApiClientFromEnv, createClient, runWithClient, serializeQueryParams } from "@sferadev/openapi-utils/effect";
export type { ApiClientConfig, ApiClientRequest, ApiClientService } from "@sferadev/openapi-utils/effect";

// ============================================================================
// Tag-based Services
// ============================================================================

${tagServices}

// ============================================================================
// Unified API Service
// ============================================================================

/**
 * Unified API service providing access to all operations organized by tag.
 * Use this for a structured, namespace-based access pattern.
 *
 * @example
 * \`\`\`ts
 * import { ApiService, makeApiClientLive } from "${packageName}/effect";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const projects = yield* ApiService.projects.listProjects();
 *   return projects;
 * });
 *
 * const result = await program.pipe(
 *   Effect.provide(makeApiClientLive({ baseUrl: "https://api.example.com", token: "your-token" })),
 *   Effect.runPromise
 * );
 * \`\`\`
 */
export const ApiService = {
${apiServiceMethods}
} as const;

// ============================================================================
// Path-based Operations Map
// ============================================================================

/**
 * Operations indexed by "METHOD /path" for direct endpoint access.
 *
 * @example
 * \`\`\`ts
 * import { operationsByPath, makeApiClientLive } from "${packageName}/effect";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* operationsByPath["GET /v4/projects"]();
 *   return result;
 * });
 *
 * const result = await program.pipe(
 *   Effect.provide(makeApiClientLive({ baseUrl: "https://api.example.com", token: "your-token" })),
 *   Effect.runPromise
 * );
 * \`\`\`
 */
export type OperationsByPath = {
${pathsType};
};

export const operationsByPath: OperationsByPath = {
${pathsObject}
};

// ============================================================================
// Type-safe Request Helper
// ============================================================================

/**
 * Type-safe request helper for making API calls by endpoint.
 *
 * @example
 * \`\`\`ts
 * import { request, makeApiClientLive } from "${packageName}/effect";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const result = yield* request("GET /v4/projects", {});
 *   return result;
 * });
 *
 * const result = await program.pipe(
 *   Effect.provide(makeApiClientLive({ baseUrl: "https://api.example.com", token: "your-token" })),
 *   Effect.runPromise
 * );
 * \`\`\`
 */
export function request<K extends keyof OperationsByPath>(
  endpoint: K,
  params: Parameters<OperationsByPath[K]>[0]
): ReturnType<OperationsByPath[K]> {
  const operation = operationsByPath[endpoint] as (params: unknown) => ReturnType<OperationsByPath[K]>;
  return operation(params);
}
`}
					</File.Source>
				</File>
			);
		},
	});
