import type { UserConfig } from "@kubb/core";
import { pluginClient } from "@kubb/plugin-client";
import { pluginMcp } from "@kubb/plugin-mcp";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginTs } from "@kubb/plugin-ts";
import { pluginZod } from "@kubb/plugin-zod";
import { extraGenerator } from "./client/extra";
import { clientGenerator } from "./client/operations";
import { serverGenerator } from "./mcp/server";
import { toolsGenerator } from "./mcp/tools";

export interface CreateConfigOptions {
	/** Name for multi-config setups */
	name?: string;
	/** Output path for generated files (default: "./src/generated") */
	outputPath?: string;
	/** Import path for the fetcher utility (default: "../utils/fetcher") */
	importPath?: string;
	/** Skip Zod schema generation (default: false) */
	skipZod?: boolean;
	/** Skip MCP generation (default: false) */
	skipMcp?: boolean;
}

interface CreatePluginsOptions {
	importPath: string;
	skipZod?: boolean;
	skipMcp?: boolean;
}

function createPlugins({ importPath, skipZod, skipMcp }: CreatePluginsOptions) {
	const plugins = [
		pluginOas({
			validate: false,
			output: {
				path: "./json",
				barrelType: false,
			},
			serverIndex: 0,
			contentType: "application/json",
		}),
		pluginTs({
			output: {
				path: "./types.ts",
				barrelType: false,
			},
			enumType: "asConst",
			enumSuffix: "Enum",
			dateType: "string",
			unknownType: "unknown",
			optionalType: "questionTokenAndUndefined",
		}),
		pluginClient({
			output: {
				path: "./components.ts",
				barrelType: false,
			},
			client: "fetch",
			dataReturnType: "data",
			pathParamsType: "object",
			paramsType: "object",
			urlType: "export",
			importPath,
			generators: [clientGenerator, extraGenerator] as any[], // Workaround for generator mismatches
		}),
	];

	if (!skipZod) {
		plugins.push(
			pluginZod({
				output: {
					path: "./schemas.ts",
					barrelType: false,
					extension: { ".ts": "" },
				},
				dateType: "string",
				unknownType: "unknown",
				importPath: "zod",
				version: "4",
			}),
		);
	}

	if (!skipMcp) {
		plugins.push(
			pluginMcp({
				output: {
					path: "./mcp.ts",
					barrelType: false,
					extension: { ".ts": "" },
				},
				client: { importPath },
				generators: [toolsGenerator, serverGenerator] as any[], // Workaround for generator mismatches
			}),
		);
	}

	return plugins;
}

export function createConfig(options: CreateConfigOptions = {}): Omit<UserConfig, "input"> {
	const {
		name,
		outputPath = "./src/generated",
		importPath = "../utils/fetcher",
		skipZod,
		skipMcp,
	} = options;
	return {
		name,
		root: ".",
		output: {
			path: outputPath,
			extension: { ".ts": "" },
			format: "biome",
			lint: false,
			clean: true,
		},
		plugins: createPlugins({ importPath, skipZod, skipMcp }),
	};
}

export const baseConfig: Omit<UserConfig, "input"> = createConfig();
