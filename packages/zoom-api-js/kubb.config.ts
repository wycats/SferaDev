import { defineConfig } from "@kubb/core";
import { baseConfig } from "@sferadev/openapi-utils";
import c from "case";
import type { OpenAPIObject, PathItemObject } from "openapi3-ts/oas30";

export default defineConfig(async () => {
	const response = await fetch(
		"https://developers.zoom.us/api-hub/meetings/methods/endpoints.json",
	);
	let openAPIDocument: OpenAPIObject = await response.json();

	// Clean operation IDs
	openAPIDocument = cleanOperationIds(openAPIDocument);

	return {
		...baseConfig,
		input: { data: openAPIDocument },
	};
});

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
