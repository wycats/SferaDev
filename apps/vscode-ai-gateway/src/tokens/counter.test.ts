import { describe, expect, it, vi } from "vitest";

const vscodeHoisted = vi.hoisted(() => {
	// Mock the role enum
	const LanguageModelChatMessageRole = {
		User: 1,
		Assistant: 2,
	};

	class LanguageModelTextPart {
		constructor(public value: string) {}
	}

	class LanguageModelDataPart {
		constructor(
			public data: Uint8Array,
			public mimeType: string,
		) {}
	}

	class LanguageModelToolCallPart {
		constructor(
			public name: string,
			public callId: string,
			public input: unknown,
		) {}
	}

	class LanguageModelToolResultPart {
		constructor(
			public callId: string,
			public content: unknown[],
		) {}
	}

	return {
		LanguageModelChatMessageRole,
		LanguageModelTextPart,
		LanguageModelDataPart,
		LanguageModelToolCallPart,
		LanguageModelToolResultPart,
	};
});

const tiktokenHoisted = vi.hoisted(() => {
	const mockEncode = vi.fn((text: string) => Array.from({ length: text.length }));
	const mockEncoding = { encode: mockEncode };
	const mockGetEncoding = vi.fn(() => mockEncoding);

	return {
		mockEncode,
		mockEncoding,
		mockGetEncoding,
	};
});

vi.mock("vscode", () => vscodeHoisted);
vi.mock("js-tiktoken", () => ({
	getEncoding: tiktokenHoisted.mockGetEncoding,
}));

import * as vscode from "vscode";
import { TokenCounter } from "./counter";

describe("TokenCounter", () => {
	it("uses o200k_base for gpt-4o families", () => {
		const counter = new TokenCounter();
		counter.estimateTextTokens("hello", "gpt-4o");

		expect(tiktokenHoisted.mockGetEncoding).toHaveBeenCalledWith("o200k_base");
	});

	it("uses o200k_base for o1 families", () => {
		const counter = new TokenCounter();
		counter.estimateTextTokens("hello", "o1-mini");

		expect(tiktokenHoisted.mockGetEncoding).toHaveBeenCalledWith("o200k_base");
	});

	it("uses cl100k_base for claude families", () => {
		const counter = new TokenCounter();
		counter.estimateTextTokens("hello", "claude-3-5-sonnet");

		expect(tiktokenHoisted.mockGetEncoding).toHaveBeenCalledWith("cl100k_base");
	});

	it("falls back to character estimation when encoding is unavailable", () => {
		tiktokenHoisted.mockGetEncoding.mockImplementationOnce(() => {
			throw new Error("encoding unavailable");
		});

		const counter = new TokenCounter();
		const result = counter.estimateTextTokens("1234567", "gpt-4");

		expect(result).toBe(2);
	});

	it("reports character fallback when encoding is unavailable", () => {
		tiktokenHoisted.mockGetEncoding.mockImplementationOnce(() => {
			throw new Error("encoding unavailable");
		});

		const counter = new TokenCounter();
		const fallback = counter.usesCharacterFallback("gpt-4");

		expect(fallback).toBe(true);
	});

	it("estimates message tokens using tiktoken", () => {
		const counter = new TokenCounter();
		const message = {
			role: vscode.LanguageModelChatMessageRole.User,
			name: "test",
			content: [new vscode.LanguageModelTextPart("Hello")],
		} as vscode.LanguageModelChatMessage;

		const result = counter.estimateMessageTokens(message, "gpt-4");

		expect(result).toBe(5);
		expect(tiktokenHoisted.mockEncode).toHaveBeenCalled();
	});
});
