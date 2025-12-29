import { defineConfig } from "@kubb/core";
import { baseConfig } from "@sferadev/openapi-utils";
import type { OpenAPIObject } from "openapi3-ts/oas30";

export default defineConfig(async () => {
	const response = await fetch("https://open-api.netlify.com/swagger.json");
	const openAPIDocument: OpenAPIObject = await response.json();

	return {
		...baseConfig,
		input: { data: openAPIDocument },
	};
});
