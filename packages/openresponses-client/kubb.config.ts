import { defineConfig } from "@kubb/core";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginTs } from "@kubb/plugin-ts";

export default defineConfig({
	root: ".",
	input: {
		path: "https://raw.githubusercontent.com/openresponses/openresponses/main/public/openapi/openapi.json",
	},
	output: {
		path: "./src/generated",
		clean: true,
	},
	plugins: [
		pluginOas({
			generators: [],
			// This is key - it ensures discriminator values come from the schema's enum, not the ref name
			discriminator: "inherit",
		}),
		pluginTs({
			output: {
				path: "./types",
			},
			// Use literal unions instead of generated enums for cleaner types
			enumType: "inlineLiteral",
		}),
	],
});
