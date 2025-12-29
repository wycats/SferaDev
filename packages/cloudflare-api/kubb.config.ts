import { defineConfig } from "@kubb/core";
import { baseConfig } from "@sferadev/openapi-utils";
import c from "case";
import type { OpenAPIObject, OperationObject, PathItemObject } from "openapi3-ts/oas30";

export default defineConfig(async () => {
	const response = await fetch(
		"https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
	);
	let openAPIDocument: OpenAPIObject = await response.json();

	// Add missing operation ids and clean them
	openAPIDocument = cleanOperationIds({ openAPIDocument });

	// Remove duplicated schemas
	openAPIDocument = removeDuplicatedSchemas(openAPIDocument);

	// Rewrite status code in components response with XX suffix to avoid invalid identifier (4XX -> 400, 5XX -> 500)
	openAPIDocument = fixStatusCodes(openAPIDocument);

	return {
		...baseConfig,
		input: { data: openAPIDocument },
	};
});

function removeDuplicatedSchemas(openAPIDocument: OpenAPIObject): OpenAPIObject {
	const schemaCount: Record<string, number> = {};
	const rewrites = new Map<string, string>();

	for (const path of Object.keys(openAPIDocument.components?.schemas ?? {})) {
		const schemaName = c.pascal(path);
		if (schemaCount[schemaName] === undefined) {
			schemaCount[schemaName] = 0;
		}

		schemaCount[schemaName] += 1;
		if (schemaCount[schemaName] > 1 && openAPIDocument.components?.schemas?.[path]) {
			rewrites.set(path, `${path}-${schemaCount[schemaName]}`);
			openAPIDocument.components.schemas[`${path}-${schemaCount[schemaName]}`] =
				openAPIDocument.components.schemas[path];
			delete openAPIDocument.components.schemas[path];
		}
	}

	// Rewrite all $ref in components with new schema names
	for (const [ref, newRef] of rewrites) {
		openAPIDocument = JSON.parse(
			JSON.stringify(openAPIDocument).replace(
				new RegExp(`"#/components/schemas/${ref}"`, "g"),
				`"#/components/schemas/${newRef}"`,
			),
		);
	}

	return openAPIDocument;
}

function fixStatusCodes(openAPIDocument: OpenAPIObject): OpenAPIObject {
	for (const [_, definition] of Object.entries(openAPIDocument.paths ?? {})) {
		for (const [_, operation] of Object.entries(definition as PathItemObject)) {
			const responses = (operation as OperationObject).responses;
			if (responses) {
				for (const [statusCode, response] of Object.entries(responses)) {
					if (statusCode.endsWith("XX")) {
						const newStatusCode = `${statusCode.slice(0, 1)}00`;
						responses[newStatusCode] = response;
						delete responses[statusCode];
					}
				}
			}
		}
	}

	return openAPIDocument;
}

function cleanOperationIds({ openAPIDocument }: { openAPIDocument: OpenAPIObject }) {
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
