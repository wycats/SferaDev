import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseModelFamily, parseModelIdentity, parseModelVersion } from "./identity";

describe("parseModelIdentity", () => {
	describe("known model patterns", () => {
		it("should parse openai model with date version", () => {
			const result = parseModelIdentity("openai:gpt-4o-2024-11-20");
			expect(result).toEqual({
				provider: "openai",
				family: "gpt-4o",
				version: "2024-11-20",
				fullId: "openai:gpt-4o-2024-11-20",
			});
		});

		it("should parse anthropic model with compact date version", () => {
			const result = parseModelIdentity("anthropic:claude-3.5-sonnet-20241022");
			expect(result).toEqual({
				provider: "anthropic",
				family: "claude-3.5-sonnet",
				version: "20241022",
				fullId: "anthropic:claude-3.5-sonnet-20241022",
			});
		});

		it("should parse google model without version", () => {
			const result = parseModelIdentity("google:gemini-2.0-flash");
			expect(result).toEqual({
				provider: "google",
				family: "gemini-2.0-flash",
				version: "latest",
				fullId: "google:gemini-2.0-flash",
			});
		});

		it("should parse mistral model with short date version", () => {
			const result = parseModelIdentity("mistral:mistral-large-2411");
			expect(result).toEqual({
				provider: "mistral",
				family: "mistral-large",
				version: "2411",
				fullId: "mistral:mistral-large-2411",
			});
		});

		it("should parse simple model without version", () => {
			const result = parseModelIdentity("anthropic:claude");
			expect(result).toEqual({
				provider: "anthropic",
				family: "claude",
				version: "latest",
				fullId: "anthropic:claude",
			});
		});

		it("should parse model with semantic version", () => {
			const result = parseModelIdentity("custom:my-model-0.1.0");
			expect(result).toEqual({
				provider: "custom",
				family: "my-model",
				version: "0.1.0",
				fullId: "custom:my-model-0.1.0",
			});
		});

		it("should parse model with underscore separator for version", () => {
			const result = parseModelIdentity("provider:model_2024-01-15");
			expect(result).toEqual({
				provider: "provider",
				family: "model",
				version: "2024-01-15",
				fullId: "provider:model_2024-01-15",
			});
		});
	});

	describe("edge cases", () => {
		it("should handle empty string", () => {
			const result = parseModelIdentity("");
			expect(result).toEqual({
				provider: "",
				family: "",
				version: "latest",
				fullId: "",
			});
		});

		it("should handle model without colon (no provider)", () => {
			const result = parseModelIdentity("gpt-4o-2024-11-20");
			expect(result).toEqual({
				provider: "",
				family: "gpt-4o",
				version: "2024-11-20",
				fullId: "gpt-4o-2024-11-20",
			});
		});

		it("should handle model with only provider and colon", () => {
			const result = parseModelIdentity("openai:");
			expect(result).toEqual({
				provider: "openai",
				family: "",
				version: "latest",
				fullId: "openai:",
			});
		});

		it("should handle model with multiple colons", () => {
			const result = parseModelIdentity("provider:namespace:model-1.0.0");
			expect(result).toEqual({
				provider: "provider",
				family: "namespace:model",
				version: "1.0.0",
				fullId: "provider:namespace:model-1.0.0",
			});
		});
	});
});

describe("parseModelFamily", () => {
	it("should extract family from model with date version", () => {
		expect(parseModelFamily("openai:gpt-4o-2024-11-20")).toBe("gpt-4o");
	});

	it("should extract family from model with compact date", () => {
		expect(parseModelFamily("anthropic:claude-3.5-sonnet-20241022")).toBe("claude-3.5-sonnet");
	});

	it("should extract family from model without version", () => {
		expect(parseModelFamily("google:gemini-2.0-flash")).toBe("gemini-2.0-flash");
	});

	it("should extract family from model with short date", () => {
		expect(parseModelFamily("mistral:mistral-large-2411")).toBe("mistral-large");
	});

	it("should extract family from simple model", () => {
		expect(parseModelFamily("anthropic:claude")).toBe("claude");
	});

	it("should extract family from model with semantic version", () => {
		expect(parseModelFamily("custom:my-model-0.1.0")).toBe("my-model");
	});

	it("should handle model without provider", () => {
		expect(parseModelFamily("gpt-4o-2024-11-20")).toBe("gpt-4o");
	});
});

describe("parseModelVersion", () => {
	it("should extract date version", () => {
		expect(parseModelVersion("openai:gpt-4o-2024-11-20")).toBe("2024-11-20");
	});

	it("should extract compact date version", () => {
		expect(parseModelVersion("anthropic:claude-3.5-sonnet-20241022")).toBe("20241022");
	});

	it("should return latest for model without version", () => {
		expect(parseModelVersion("google:gemini-2.0-flash")).toBe("latest");
	});

	it("should extract short date version", () => {
		expect(parseModelVersion("mistral:mistral-large-2411")).toBe("2411");
	});

	it("should return latest for simple model", () => {
		expect(parseModelVersion("anthropic:claude")).toBe("latest");
	});

	it("should extract semantic version", () => {
		expect(parseModelVersion("custom:my-model-0.1.0")).toBe("0.1.0");
	});

	it("should handle model without provider", () => {
		expect(parseModelVersion("gpt-4o-2024-11-20")).toBe("2024-11-20");
	});
});

describe("property-based tests", () => {
	// Arbitrary for valid provider names (alphanumeric, lowercase)
	const providerArb = fc.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
		minLength: 1,
		maxLength: 20,
	});

	// Arbitrary for valid family names (alphanumeric with dots and hyphens)
	const familyArb = fc
		.stringOf(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-."), {
			minLength: 1,
			maxLength: 30,
		})
		.filter(
			(s) => !s.startsWith("-") && !s.endsWith("-") && !s.startsWith(".") && !s.endsWith("."),
		);

	// Arbitrary for version patterns
	const dateVersionArb = fc
		.tuple(
			fc.integer({ min: 2020, max: 2030 }),
			fc.integer({ min: 1, max: 12 }),
			fc.integer({ min: 1, max: 28 }),
		)
		.map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);

	const shortDateVersionArb = fc.integer({ min: 2020, max: 2099 }).map((y) => String(y));

	const semverArb = fc
		.tuple(
			fc.integer({ min: 0, max: 99 }),
			fc.integer({ min: 0, max: 99 }),
			fc.integer({ min: 0, max: 99 }),
		)
		.map(([major, minor, patch]) => `${major}.${minor}.${patch}`);

	const versionArb = fc.oneof(dateVersionArb, shortDateVersionArb, semverArb);

	describe("roundtrip property", () => {
		it("parseModelIdentity(id).fullId === id", () => {
			fc.assert(
				fc.property(providerArb, familyArb, (provider, family) => {
					const id = `${provider}:${family}`;
					const result = parseModelIdentity(id);
					return result.fullId === id;
				}),
				{ numRuns: 100 },
			);
		});
	});

	describe("provider consistency", () => {
		it("provider is always the part before the first colon", () => {
			fc.assert(
				fc.property(providerArb, familyArb, (provider, family) => {
					const id = `${provider}:${family}`;
					const result = parseModelIdentity(id);
					return result.provider === provider;
				}),
				{ numRuns: 100 },
			);
		});
	});

	describe("family + version reconstruction", () => {
		it("family and version can be extracted consistently with version suffix", () => {
			fc.assert(
				fc.property(providerArb, familyArb, versionArb, (provider, family, version) => {
					const id = `${provider}:${family}-${version}`;
					const result = parseModelIdentity(id);
					// The family should be extracted and version should match
					return result.provider === provider && result.version === version;
				}),
				{ numRuns: 100 },
			);
		});
	});

	describe("idempotence", () => {
		it("multiple calls produce identical output", () => {
			fc.assert(
				fc.property(providerArb, familyArb, (provider, family) => {
					const id = `${provider}:${family}`;
					const result1 = parseModelIdentity(id);
					const result2 = parseModelIdentity(id);
					const result3 = parseModelIdentity(id);
					return (
						result1.provider === result2.provider &&
						result2.provider === result3.provider &&
						result1.family === result2.family &&
						result2.family === result3.family &&
						result1.version === result2.version &&
						result2.version === result3.version &&
						result1.fullId === result2.fullId &&
						result2.fullId === result3.fullId
					);
				}),
				{ numRuns: 100 },
			);
		});
	});

	describe("structural invariants", () => {
		it("provider never contains a colon", () => {
			fc.assert(
				fc.property(fc.string({ minLength: 1, maxLength: 50 }), (id) => {
					const result = parseModelIdentity(id);
					return !result.provider.includes(":");
				}),
				{ numRuns: 100 },
			);
		});

		it("version is either 'latest' or matches a version pattern", () => {
			fc.assert(
				fc.property(providerArb, familyArb, (provider, family) => {
					const id = `${provider}:${family}`;
					const result = parseModelIdentity(id);
					// Version should be 'latest' or match version patterns
					const versionPattern = /^(latest|\d{4}-\d{2}-\d{2}|\d{4,8}|\d+\.\d+(?:\.\d+)?)$/;
					return versionPattern.test(result.version);
				}),
				{ numRuns: 100 },
			);
		});
	});
});
