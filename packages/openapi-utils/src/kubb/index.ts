import type { UserConfig } from "@kubb/core";
import { pluginClient } from "@kubb/plugin-client";
import { pluginMcp } from "@kubb/plugin-mcp";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginTs } from "@kubb/plugin-ts";
import { pluginZod } from "@kubb/plugin-zod";
import { extraGenerator } from "./client/extra";
import { clientGenerator } from "./client/operations";
import { effectOperationsGenerator, effectServiceGenerator } from "./effect";
import { serverGenerator } from "./mcp/server";
import { toolsGenerator } from "./mcp/tools";

export const baseConfig: Omit<UserConfig, "input"> = {
	root: ".",
	output: {
		path: "./src/generated",
		extension: {
			".ts": "",
		},
		format: "biome",
		lint: false,
		clean: true,
	},
	plugins: [
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
			importPath: "../utils/fetcher",
			generators: [clientGenerator, extraGenerator] as any[], // Workaround for generator mismatches
		}),
		pluginZod({
			output: {
				path: "./schemas.ts",
				barrelType: false,
			},
			dateType: "string",
			unknownType: "unknown",
			importPath: "zod",
			version: "4",
		}),
		pluginMcp({
			output: {
				path: "./mcp.ts",
				barrelType: false,
			},
			client: { importPath: "../utils/fetcher" },
			generators: [toolsGenerator, serverGenerator] as any[], // Workaround for generator mismatches
		}),
		// Effect-TS service generation
		pluginClient({
			output: {
				path: "./effect.ts",
				barrelType: false,
			},
			client: "fetch",
			dataReturnType: "data",
			pathParamsType: "object",
			paramsType: "object",
			importPath: "../utils/effect",
			generators: [effectOperationsGenerator, effectServiceGenerator] as any[],
		}),
	],
};
