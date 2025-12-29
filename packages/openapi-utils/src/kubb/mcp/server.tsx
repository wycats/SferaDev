import { usePluginManager } from "@kubb/core/hooks";
import { camelCase } from "@kubb/core/transformers";
import { isNullable, isReference } from "@kubb/oas";
import type { PluginMcp } from "@kubb/plugin-mcp";
import type { OperationSchemas } from "@kubb/plugin-oas";
import { createReactGenerator } from "@kubb/plugin-oas/generators";
import { useOas, useOperationManager } from "@kubb/plugin-oas/hooks";
import { getBanner, getFooter, getPathParams, isOptional } from "@kubb/plugin-oas/utils";
import { pluginTsName } from "@kubb/plugin-ts";
import { pluginZodName } from "@kubb/plugin-zod";
import { File, FunctionParams } from "@kubb/react-fabric";

// JavaScript reserved keywords that cannot be used as identifiers in strict mode
const RESERVED_KEYWORDS = new Set([
	"break",
	"case",
	"catch",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"finally",
	"for",
	"function",
	"if",
	"in",
	"instanceof",
	"new",
	"return",
	"switch",
	"this",
	"throw",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"class",
	"const",
	"enum",
	"export",
	"extends",
	"import",
	"super",
	"implements",
	"interface",
	"let",
	"package",
	"private",
	"protected",
	"public",
	"static",
	"yield",
	"await",
	"null",
	"true",
	"false",
]);

function escapeReservedKeyword(name: string): string {
	return RESERVED_KEYWORDS.has(name) ? `${name}Param` : name;
}

/**
 * Builds the API call object with proper keyword mapping.
 * When a path param name is a reserved keyword (e.g., "package"),
 * we use the escaped variable name (packageParam) but map it back
 * to the original key name: { package: packageParam }
 */
function buildApiCall({ schemas }: { schemas: OperationSchemas }): string {
	const parts: string[] = [];

	// Build pathParams with proper keyword mapping
	const pathParams = getPathParams(schemas.pathParams, { typed: false });
	if (Object.keys(pathParams).length > 0) {
		const pathParamEntries = Object.entries(pathParams).map(([key]) => {
			const camelKey = camelCase(key);
			const escapedKey = escapeReservedKeyword(camelKey);
			// If the key was escaped, we need to map it: { originalKey: escapedVariable }
			if (camelKey !== escapedKey) {
				return `${camelKey}: ${escapedKey}`;
			}
			return camelKey;
		});
		parts.push(`pathParams: { ${pathParamEntries.join(", ")} }`);
	}

	if (schemas.request?.name) {
		parts.push("body");
	}

	if (schemas.queryParams?.name) {
		parts.push("queryParams");
	}

	if (schemas.headerParams?.name) {
		parts.push("headers");
	}

	parts.push("config");

	return `{ ${parts.join(", ")} }`;
}

export const serverGenerator: ReturnType<typeof createReactGenerator<PluginMcp>> =
	createReactGenerator<PluginMcp>({
		name: "operations",
		Operations({ operations, generator, plugin }) {
			const pluginManager = usePluginManager();
			const { options } = plugin;

			const oas = useOas();
			const { getFile, getName, getSchemas } = useOperationManager(generator);

			const fileName = "mcp";
			const file = pluginManager.getFile({ name: fileName, extname: ".ts", pluginKey: plugin.key });

			const operationsMapped = operations.map((operation) => {
				return {
					tool: {
						name:
							operation.getOperationId() ||
							operation.getSummary() ||
							`${operation.method.toUpperCase()} ${operation.path}`,
						description:
							operation.getDescription() ||
							`Make a ${operation.method.toUpperCase()} request to ${operation.path}`,
					},
					mcp: {
						name: getName(operation, {
							type: "function",
						}),
						file: getFile(operation),
					},
					zod: {
						name: getName(operation, {
							type: "function",
							pluginKey: [pluginZodName],
						}),
						schemas: getSchemas(operation, { pluginKey: [pluginZodName], type: "function" }),
						file: getFile(operation, { pluginKey: [pluginZodName] }),
					},
					type: {
						schemas: getSchemas(operation, { pluginKey: [pluginTsName], type: "type" }),
					},
				};
			});

			const imports = operationsMapped.flatMap(({ mcp, zod }) => {
				return [
					<File.Import key={mcp.name} name={[mcp.name]} root={file.path} path={mcp.file.path} />,
					<File.Import
						key={zod.name}
						name={
							[
								zod.schemas.request?.name,
								zod.schemas.pathParams?.name,
								zod.schemas.queryParams?.name,
								zod.schemas.headerParams?.name,
							].filter(Boolean) as string[]
						}
						root={file.path}
						path={zod.file.path}
					/>,
				];
			});

			return (
				<File
					baseName={file.baseName}
					path={file.path}
					meta={file.meta}
					// @ts-expect-error conflict with react-fabric types
					banner={getBanner({ oas, output: options.output, config: pluginManager.config })}
					footer={getFooter({ oas, output: options.output })}
				>
					{imports}

					<File.Source name={fileName} isExportable isIndexable>
						{`
            import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
            
            export function initMcpTools<Server>(serverLike: Server, config: FetcherConfig) {
              const server = serverLike as McpServer;
              
              ${operationsMapped
								.map(({ tool, mcp, zod }) => {
									const params = getParams({ schemas: zod.schemas });
									const apiCall = buildApiCall({ schemas: zod.schemas });

									if (
										zod.schemas.request?.name ||
										zod.schemas.headerParams?.name ||
										zod.schemas.queryParams?.name ||
										zod.schemas.pathParams?.name
									) {
										return `
                      server.registerTool(${JSON.stringify(tool.name)}, { description: ${JSON.stringify(tool.description)}, inputSchema: ${params.toObjectValue()} }, async (${params.toObject()}) => {
                        try {
                          return await ${mcp.name}(${apiCall})
                        } catch (error) {
                          return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
                        }
                      })`;
									}

									return `
                    server.registerTool(${JSON.stringify(tool.name)}, { description: ${JSON.stringify(tool.description)} }, async () => {
                      try {
                        return await ${mcp.name}({ config })
                      } catch (error) {
                        return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
                      }
                    })
          `;
								})
								.filter(Boolean)
								.join("\n")}
            }`}
					</File.Source>
				</File>
			);
		},
	});

function getParams({ schemas }: { schemas: OperationSchemas }) {
	const pathParams = getPathParams(schemas.pathParams, {
		typed: false,
	});

	return FunctionParams.factory({
		data: {
			mode: "object",
			children: {
				...Object.entries(pathParams).reduce(
					(acc, [key, param]) => {
						if (param && schemas.pathParams?.name) {
							let suffix = ".shape";

							if (isNullable(schemas.pathParams.schema)) {
								if (isReference(schemas.pathParams)) {
									suffix = ".unwrap().schema.unwrap().shape";
								} else {
									suffix = ".unwrap().shape";
								}
							} else {
								if (isReference(schemas.pathParams)) {
									suffix = ".schema.shape";
								}
							}

							(param as any).value = `${schemas.pathParams?.name}${suffix}['${key}']`;
						}

						acc[escapeReservedKeyword(camelCase(key))] = param;
						return acc;
					},
					{} as Record<string, any>,
				),
				body: schemas.request?.name
					? {
							value: schemas.request?.name,
							optional: isOptional(schemas.request?.schema),
						}
					: undefined,
				queryParams: schemas.queryParams?.name
					? {
							value: schemas.queryParams?.name,
							optional: isOptional(schemas.queryParams?.schema),
						}
					: undefined,
				headers: schemas.headerParams?.name
					? {
							value: schemas.headerParams?.name,
							optional: isOptional(schemas.headerParams?.schema),
						}
					: undefined,
			},
		},
	});
}
