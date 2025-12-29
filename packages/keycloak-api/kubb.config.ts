import fs from "node:fs";
import type { UserConfig } from "@kubb/core";
import { defineConfig } from "@kubb/core";
import { pluginClient } from "@kubb/plugin-client";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginTs } from "@kubb/plugin-ts";
import { pluginZod } from "@kubb/plugin-zod";
import { clientGenerator, extraGenerator } from "@sferadev/openapi-utils";
import c from "case";
import type { OpenAPIObject, PathItemObject } from "openapi3-ts/oas30";
import yaml from "yaml";

function createPlugins(importPath: string) {
	return [
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
			generators: [clientGenerator, extraGenerator] as any[],
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
	];
}

function createConfig(name: string, openAPIDocument: OpenAPIObject): UserConfig {
	return {
		name,
		root: ".",
		input: { data: openAPIDocument },
		output: {
			path: `./src/${name}/generated`,
			extension: { ".ts": "" },
			format: "biome",
			lint: false,
			clean: true,
		},
		plugins: createPlugins("../../utils/fetcher"),
	};
}

export default defineConfig(async () => {
	// Fetch admin OpenAPI spec
	const adminResponse = await fetch(
		"https://www.keycloak.org/docs-api/latest/rest-api/openapi.json",
	);
	let adminSpec: OpenAPIObject = await adminResponse.json();
	adminSpec = transformSpec(adminSpec);

	// Read account OpenAPI spec from local file
	const accountYaml = fs.readFileSync("./specs/account.yaml", "utf-8");
	let accountSpec: OpenAPIObject = yaml.parse(accountYaml);
	accountSpec = transformSpec(accountSpec);

	return [createConfig("admin", adminSpec), createConfig("account", accountSpec)];
});

function transformSpec(openAPIDocument: OpenAPIObject): OpenAPIObject {
	let spec = cleanOperationIds(openAPIDocument);
	spec = sortArrays(spec);
	warnForDuplicatedPathParameters(spec);
	return spec;
}

function sortArrays(openAPIDocument: OpenAPIObject) {
	function sortEnumValuesRecursively<T>(obj: T): T {
		if (Array.isArray(obj)) {
			return obj.sort() as T;
		} else if (typeof obj === "object" && !!obj) {
			return Object.fromEntries(
				Object.entries(obj as any).map(([key, value]) => [key, sortEnumValuesRecursively(value)]),
			) as T;
		} else {
			return obj;
		}
	}

	return sortEnumValuesRecursively(openAPIDocument);
}

function cleanOperationIds(openAPIDocument: OpenAPIObject) {
	for (const [key, path] of Object.entries(
		openAPIDocument.paths as Record<string, PathItemObject>,
	)) {
		for (const method of ["get", "put", "post", "patch", "delete"] as const) {
			if (path[method]) {
				const operationId = path[method].operationId ?? `${method} ${key}`;
				openAPIDocument.paths[key][method] = {
					...openAPIDocument.paths[key][method],
					operationId: c.camel(operationId),
				};
			}
		}
	}

	return openAPIDocument;
}

function warnForDuplicatedPathParameters(openAPIDocument: OpenAPIObject) {
	for (const path of Object.keys(openAPIDocument.paths as Record<string, PathItemObject>)) {
		const pathParameters = path.match(/{([^}]+)}/g)?.map((param) => param.slice(1, -1)) ?? [];
		const duplicatedPathParameters = pathParameters.filter(
			(param, index) => pathParameters.indexOf(param) !== index,
		);
		if (duplicatedPathParameters.length > 0) {
			console.warn(
				`Duplicated path parameters in path "${path}": ${duplicatedPathParameters.join(", ")}`,
			);
		}
	}
}
