import { defineConfig } from "@kubb/core";
import { baseConfig } from "@sferadev/openapi-utils";
import c from "case";
import type { OpenAPIObject, PathItemObject, SchemaObject } from "openapi3-ts/oas30";

export default defineConfig(async () => {
	const response = await fetch("https://api.nuki.io/static/swagger/swagger.json");
	let openAPIDocument: OpenAPIObject = await response.json();

	// Clean operation IDs
	openAPIDocument = cleanOperationIds(openAPIDocument);

	// Fix invalid 'int' schema types (should be 'integer')
	openAPIDocument = fixInvalidTypes(openAPIDocument);

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
				const defaultOperationId = path[method].operationId ?? `${method} ${key}`;
				const operationId = `${method} ${defaultOperationId.split("_")[0]}`;
				openAPIDocument.paths[key][method] = {
					...openAPIDocument.paths[key][method],
					operationId: c.camel(operationId),
				};
			}
		}
	}

	return openAPIDocument;
}

function fixInvalidTypes(openAPIDocument: OpenAPIObject) {
	// Recursively fix 'int' -> 'integer' in all schemas
	function fixSchema(schema: SchemaObject): void {
		if (!schema || typeof schema !== "object") return;

		// Fix invalid 'int' type
		if ((schema as any).type === "int") {
			(schema as any).type = "integer";
		}

		// Recurse into nested schemas
		if (schema.properties) {
			for (const prop of Object.values(schema.properties)) {
				fixSchema(prop as SchemaObject);
			}
		}
		if (schema.items) {
			fixSchema(schema.items as SchemaObject);
		}
		if (schema.allOf) {
			for (const s of schema.allOf) fixSchema(s as SchemaObject);
		}
		if (schema.oneOf) {
			for (const s of schema.oneOf) fixSchema(s as SchemaObject);
		}
		if (schema.anyOf) {
			for (const s of schema.anyOf) fixSchema(s as SchemaObject);
		}
		if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
			fixSchema(schema.additionalProperties as SchemaObject);
		}
	}

	// Fix schemas in components (OpenAPI 3.0)
	if (openAPIDocument.components?.schemas) {
		for (const schema of Object.values(openAPIDocument.components.schemas)) {
			fixSchema(schema as SchemaObject);
		}
	}

	// Fix schemas in definitions (Swagger 2.0)
	if ((openAPIDocument as any).definitions) {
		for (const schema of Object.values((openAPIDocument as any).definitions)) {
			fixSchema(schema as SchemaObject);
		}
	}

	// Fix schemas in parameters
	if (openAPIDocument.components?.parameters) {
		for (const param of Object.values(openAPIDocument.components.parameters)) {
			if ((param as any).schema) {
				fixSchema((param as any).schema as SchemaObject);
			}
		}
	}

	// Fix inline parameters in paths
	for (const path of Object.values(openAPIDocument.paths ?? {})) {
		for (const method of ["get", "put", "post", "patch", "delete"] as const) {
			const operation = (path as PathItemObject)[method];
			if (operation?.parameters) {
				for (const param of operation.parameters) {
					// OpenAPI 3.0 style: schema.type
					if ((param as any).schema) {
						fixSchema((param as any).schema as SchemaObject);
					}
					// Swagger 2.0 style: type directly on parameter
					if ((param as any).type === "int") {
						(param as any).type = "integer";
					}
				}
			}
			if (operation?.requestBody) {
				const content = (operation.requestBody as any).content;
				if (content) {
					for (const mediaType of Object.values(content)) {
						if ((mediaType as any).schema) {
							fixSchema((mediaType as any).schema as SchemaObject);
						}
					}
				}
			}
		}
	}

	// Also fix path-level parameters (Swagger 2.0)
	for (const path of Object.values(openAPIDocument.paths ?? {})) {
		if ((path as any).parameters) {
			for (const param of (path as any).parameters) {
				if ((param as any).schema) {
					fixSchema((param as any).schema as SchemaObject);
				}
				if ((param as any).type === "int") {
					(param as any).type = "integer";
				}
			}
		}
	}

	return openAPIDocument;
}
