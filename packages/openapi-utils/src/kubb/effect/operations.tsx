import { usePluginManager } from "@kubb/core/hooks";
import type { PluginClient } from "@kubb/plugin-client";
import { createReactGenerator } from "@kubb/plugin-oas/generators";
import { useOas, useOperationManager } from "@kubb/plugin-oas/hooks";
import { getBanner, getFooter } from "@kubb/plugin-oas/utils";
import { pluginTsName } from "@kubb/plugin-ts";
import { File } from "@kubb/react-fabric";
import { EffectOperation } from "../components/effect-operation";

export const effectOperationsGenerator: ReturnType<typeof createReactGenerator<PluginClient>> =
	createReactGenerator<PluginClient>({
		name: "effect-operations",
		Operation({ plugin, operation, generator }) {
			const pluginManager = usePluginManager();
			const {
				options,
				options: { output },
			} = plugin;

			const oas = useOas();
			const { getSchemas, getName, getFile } = useOperationManager(generator);

			const effect = {
				name: getName(operation, { type: "function" }),
				file: getFile(operation),
			};

			const type = {
				file: getFile(operation, { pluginKey: [pluginTsName] }),
				schemas: getSchemas(operation, { pluginKey: [pluginTsName], type: "type" }),
			};

			return (
				<File
					baseName={effect.file.baseName}
					path={effect.file.path}
					meta={effect.file.meta}
					// @ts-expect-error conflict with react-fabric types
					banner={getBanner({ oas, output, config: pluginManager.config })}
					footer={getFooter({ oas, output })}
				>
					<File.Import name={["Effect"]} path="effect" />
					<File.Import
						name={["ApiClient", "ApiError", "ValidationError", "serializeQueryParams"]}
						path="@sferadev/openapi-utils/effect"
					/>
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
						root={effect.file.path}
						path={type.file.path}
						isTypeOnly
					/>

					<EffectOperation
						name={effect.name}
						paramsCasing={options.paramsCasing}
						typeSchemas={type.schemas}
						operation={operation}
					/>
				</File>
			);
		},
	});
