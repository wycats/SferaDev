import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
	class LanguageModelTextPart {
		value: string;

		constructor(value: string) {
			this.value = value;
		}
	}

	class LanguageModelDataPart {
		data: Uint8Array;
		mimeType: string;

		constructor(data: Uint8Array, mimeType: string) {
			this.data = data;
			this.mimeType = mimeType;
		}
	}

	class LanguageModelToolCallPart {
		name: string;
		callId: string;
		input: unknown;

		constructor(name: string, callId: string, input: unknown) {
			this.name = name;
			this.callId = callId;
			this.input = input;
		}
	}

	class LanguageModelToolResultPart {
		callId: string;
		content: unknown;

		constructor(callId: string, content: unknown) {
			this.callId = callId;
			this.content = content;
		}
	}

	return {
		LanguageModelTextPart,
		LanguageModelDataPart,
		LanguageModelToolCallPart,
		LanguageModelToolResultPart,
	};
});

vi.mock("vscode", () => hoisted);

import * as vscode from "vscode";
import { TokenCache } from "./cache";

describe("TokenCache", () => {
	const createMessage = (parts: vscode.LanguageModelChatMessagePart[]) =>
		({
			role: "user",
			content: parts,
		}) as vscode.LanguageModelChatMessage;

	it("returns same digest for same content", () => {
		const cache = new TokenCache();
		const messageA = createMessage([new vscode.LanguageModelTextPart("Hello")]);
		const messageB = createMessage([new vscode.LanguageModelTextPart("Hello")]);

		expect(cache.digestMessage(messageA)).toBe(cache.digestMessage(messageB));
	});

	it("returns different digest for different content", () => {
		const cache = new TokenCache();
		const messageA = createMessage([new vscode.LanguageModelTextPart("Hello")]);
		const messageB = createMessage([new vscode.LanguageModelTextPart("Hello!")]);

		expect(cache.digestMessage(messageA)).not.toBe(cache.digestMessage(messageB));
	});

	it("returns undefined for uncached messages", () => {
		const cache = new TokenCache();
		const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

		expect(cache.getCached(message, "openai")).toBeUndefined();
	});

	it("caches and retrieves actual tokens", () => {
		const cache = new TokenCache();
		const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

		cache.cacheActual(message, "openai", 42);

		expect(cache.getCached(message, "openai")).toBe(42);
	});

	it("isolates cache entries by model family", () => {
		const cache = new TokenCache();
		const message = createMessage([new vscode.LanguageModelTextPart("Hello")]);

		cache.cacheActual(message, "openai", 42);

		expect(cache.getCached(message, "anthropic")).toBeUndefined();
		expect(cache.getCached(message, "openai")).toBe(42);
	});

	it("includes tool result content in digest", () => {
		const cache = new TokenCache();
		const contentA = [new vscode.LanguageModelTextPart("Result")];
		const contentB = [new vscode.LanguageModelTextPart("Result changed")];
		const messageA = createMessage([
			new vscode.LanguageModelToolResultPart("call-1", contentA),
		]);
		const messageB = createMessage([
			new vscode.LanguageModelToolResultPart("call-1", contentB),
		]);

		expect(cache.digestMessage(messageA)).not.toBe(cache.digestMessage(messageB));
	});
});
