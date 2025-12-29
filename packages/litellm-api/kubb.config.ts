import { defineConfig } from "@kubb/core";
import { baseConfig } from "@sferadev/openapi-utils";
import c from "case";
import type { OpenAPIObject, PathItemObject } from "openapi3-ts/oas30";

export default defineConfig(async () => {
	const response = await fetch("https://www.demo.litellm.ai/openapi.json");
	let openAPIDocument: OpenAPIObject = await response.json();

	// Remove all pass-through paths that end with {endpoint}
	openAPIDocument = ignorePassThroughPaths(openAPIDocument);

	// Move inline $defs to #/components/schemas
	openAPIDocument = moveDefsToComponents(openAPIDocument);

	// Deduplicate operation IDs
	openAPIDocument = deduplicateOperationIds(openAPIDocument);

	// Fix empty response schemas
	openAPIDocument = pathReturnFixCatchAll(openAPIDocument);

	// Fix specific API returns
	openAPIDocument = fixAPIReturns(openAPIDocument, [
		{
			paths: ["/model/info/", "/v1/model/info"],
			methods: ["get"],
			responses: {
				"200": obj({ data: arrayOf(schemaRef("Deployment")) }),
			},
		},
	]);

	// Remove duplicated tags
	openAPIDocument = removeDuplicatedTags(openAPIDocument);

	// Clean operation IDs
	openAPIDocument = cleanOperationIds(openAPIDocument);

	return {
		...baseConfig,
		input: { data: openAPIDocument },
	};
});

function removeDuplicatedTags(openAPIObject: OpenAPIObject) {
	return {
		...openAPIObject,
		paths: Object.fromEntries(
			Object.entries(openAPIObject.paths ?? {}).map(([path, pathItem]) => {
				for (const method of Object.keys(pathItem as any)) {
					const operation = (pathItem as any)[method];
					if (operation?.tags) {
						operation.tags = [...new Set(operation.tags)];
					}
				}
				return [path, pathItem];
			}),
		),
	} as OpenAPIObject;
}

function deduplicateOperationIds(openAPIObject: OpenAPIObject) {
	const operationIdCount: Record<string, number> = {};
	const methods = ["get", "post", "put", "patch", "delete"] as const;

	for (const pathItem of Object.values(openAPIObject.paths ?? {})) {
		for (const method of methods) {
			const operation = (pathItem as any)?.[method];
			if (!operation?.operationId) continue;

			const originalId = operation.operationId;
			if (operationIdCount[originalId] === undefined) {
				operationIdCount[originalId] = 0;
			}
			operationIdCount[originalId] += 1;

			if (operationIdCount[originalId] > 1) {
				operation.operationId = `${originalId}_${operationIdCount[originalId]}`;
			}
		}
	}

	return openAPIObject;
}

function ignorePassThroughPaths(openAPIObject: OpenAPIObject) {
	const paths = openAPIObject.paths ?? {};
	const filteredPaths = Object.keys(paths).filter((path) => !path.endsWith("{endpoint}"));
	return {
		...openAPIObject,
		paths: Object.fromEntries(filteredPaths.map((path) => [path, paths[path]])),
	} as OpenAPIObject;
}

function moveDefsToComponents(openAPIObject: OpenAPIObject) {
	const collectedDefs: Record<string, any> = {};

	function collectDefs(obj: any): any {
		if (typeof obj !== "object" || obj === null) return obj;

		if (Array.isArray(obj)) {
			return obj.map(collectDefs);
		}

		const result: Record<string, any> = {};
		for (const [key, value] of Object.entries(obj)) {
			if (key === "$defs" && typeof value === "object" && value !== null) {
				Object.assign(collectedDefs, value);
			} else {
				result[key] = collectDefs(value);
			}
		}
		return result;
	}

	function updateRefs(obj: any): any {
		if (typeof obj !== "object" || obj === null) return obj;

		if (Array.isArray(obj)) {
			return obj.map(updateRefs);
		}

		const result: Record<string, any> = {};
		for (const [key, value] of Object.entries(obj)) {
			if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
				result[key] = value.replace("#/$defs/", "#/components/schemas/");
			} else {
				result[key] = updateRefs(value);
			}
		}
		return result;
	}

	let result = collectDefs(openAPIObject);
	result = updateRefs(result);

	if (Object.keys(collectedDefs).length > 0) {
		result.components = result.components || {};
		result.components.schemas = {
			...result.components.schemas,
			...updateRefs(collectedDefs),
		};
	}

	return result as OpenAPIObject;
}

function pathReturnFixCatchAll(openAPIObject: OpenAPIObject) {
	const catchAll = { type: "object", properties: {}, additionalProperties: true };
	const methods = ["get", "post", "put", "delete"];
	const JSON_CONTENT_TYPE = "application/json";

	for (const pathItem of Object.values(openAPIObject.paths ?? {})) {
		for (const method of methods) {
			const methodItem = (pathItem as any)?.[method];
			if (!methodItem?.responses) continue;

			for (const responseItem of Object.values(methodItem.responses)) {
				const content = (responseItem as any).content;
				if (!content?.[JSON_CONTENT_TYPE]) continue;

				const schema = content[JSON_CONTENT_TYPE].schema;
				if (schema && Object.keys(schema).length === 0) {
					content[JSON_CONTENT_TYPE].schema = catchAll;
				}
			}
		}
	}

	return openAPIObject;
}

type ResponseUpdate = {
	paths: string[];
	methods: string[];
	responses: Record<string, any>;
};

function fixAPIReturns(openAPIObject: OpenAPIObject, apiUpdates: ResponseUpdate[]) {
	for (const update of apiUpdates) {
		for (const path of update.paths) {
			const pathItem = openAPIObject.paths?.[path];
			if (!pathItem) continue;

			for (const method of update.methods) {
				const methodItem = (pathItem as any)?.[method];
				if (!methodItem?.responses) continue;

				for (const [code, schema] of Object.entries(update.responses)) {
					const responseItem = methodItem.responses[code];
					if (responseItem) {
						const content = responseItem.content;
						if (content?.["application/json"]) {
							content["application/json"].schema = schema;
						}
					}
				}
			}
		}
	}

	return openAPIObject;
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

function obj(properties: Record<string, any>) {
	return {
		type: "object",
		properties,
		additionalProperties: true,
	};
}

function arrayOf(type: any) {
	return {
		type: "array",
		items: type,
	};
}

function schemaRef(ref: string) {
	return { $ref: `#/components/schemas/${ref}` };
}
