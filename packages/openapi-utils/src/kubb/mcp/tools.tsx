import { usePluginManager } from "@kubb/core/hooks";
import type { PluginMcp } from "@kubb/plugin-mcp";
import { createReactGenerator } from "@kubb/plugin-oas/generators";
import { useOas, useOperationManager } from "@kubb/plugin-oas/hooks";
import { getBanner, getFooter } from "@kubb/plugin-oas/utils";
import { pluginTsName } from "@kubb/plugin-ts";
import { File } from "@kubb/react-fabric";
import { ClientOperation } from "../components/client-operation";

export const toolsGenerator: ReturnType<typeof createReactGenerator<PluginMcp>> =
	createReactGenerator<PluginMcp>({
		name: "mcp",
		Operation({ operation, generator, plugin }) {
			const pluginManager = usePluginManager();
			const { options } = plugin;
			const oas = useOas();

			const { getSchemas, getName, getFile } = useOperationManager(generator);

			const mcp = {
				name: getName(operation, { type: "function" }),
				file: getFile(operation),
			};

			const type = {
				file: getFile(operation, { pluginKey: [pluginTsName] }),
				schemas: getSchemas(operation, { pluginKey: [pluginTsName], type: "type" }),
			};

			return (
				<File
					baseName={mcp.file.baseName}
					path={mcp.file.path}
					meta={mcp.file.meta}
					// @ts-expect-error conflict with react-fabric types
					banner={getBanner({ oas, output: options.output, config: pluginManager.config })}
					footer={getFooter({ oas, output: options.output })}
				>
					<File.Import name={"client"} path={options.client.importPath ?? ""} />
					<File.Import
						name={["FetcherConfig", "ErrorWrapper"]}
						path={options.client.importPath ?? ""}
						isTypeOnly
					/>
					<File.Import
						name={["RequestConfig", "ResponseErrorConfig"]}
						path={options.client.importPath ?? ""}
						isTypeOnly
					/>
					<File.Import name={["CallToolResult"]} path="../utils/mcp" isTypeOnly />
					<File.Import
						name={
							[
								type.schemas.request?.name,
								type.schemas.response.name,
								type.schemas.pathParams?.name,
								type.schemas.queryParams?.name,
								type.schemas.headerParams?.name,
								...(type.schemas.statusCodes?.map((item) => item.name) || []),
							].filter(Boolean) as string[]
						}
						root={mcp.file.path}
						path={type.file.path}
						isTypeOnly
					/>

					<ClientOperation
						name={mcp.name}
						returnType={"Promise<CallToolResult>"}
						baseURL={plugin.options.client.baseURL}
						operation={operation}
						typeSchemas={type.schemas}
						zodSchemas={undefined}
						paramsCasing={"camelcase"}
						parser={"client"}
					>
						{`return { content: [{ type: 'text', text: JSON.stringify(data) }] };`}
					</ClientOperation>
				</File>
			);
		},
	});
