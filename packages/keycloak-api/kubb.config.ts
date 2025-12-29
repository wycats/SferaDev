import fs from "node:fs";
import { defineConfig } from "@kubb/core";
import { createConfig } from "@sferadev/openapi-utils";
import c from "case";
import type { OpenAPIObject, PathItemObject } from "openapi3-ts/oas30";
import yaml from "yaml";

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

	return [
		{
			...createConfig({
				name: "admin",
				outputPath: "./src/admin/generated",
				importPath: "../../utils/fetcher",
			}),
			input: { data: adminSpec },
		},
		{
			...createConfig({
				name: "account",
				outputPath: "./src/account/generated",
				importPath: "../../utils/fetcher",
			}),
			input: { data: accountSpec },
		},
	];
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
