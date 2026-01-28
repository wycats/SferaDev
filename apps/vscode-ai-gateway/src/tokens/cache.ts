import * as crypto from "crypto";
import * as vscode from "vscode";

export interface CachedTokenCount {
	digest: string;
	modelFamily: string;
	actualTokens: number;
	timestamp: number;
}

// Extract the message part type from the content array
type MessagePart = vscode.LanguageModelChatMessage["content"] extends Iterable<infer T> ? T : never;

type IterableLike<T> = Iterable<T> | ArrayLike<T>;

export class TokenCache {
	private cache = new Map<string, CachedTokenCount>();

	digestMessage(message: vscode.LanguageModelChatMessage): string {
		const content = {
			role: message.role,
			parts: this.serializeParts(message.content),
		};
		const serialized = JSON.stringify(content);
		return crypto.createHash("sha256").update(serialized).digest("hex");
	}

	getCached(message: vscode.LanguageModelChatMessage, modelFamily: string): number | undefined {
		const digest = this.digestMessage(message);
		const key = this.cacheKey(modelFamily, digest);
		return this.cache.get(key)?.actualTokens;
	}

	cacheActual(
		message: vscode.LanguageModelChatMessage,
		modelFamily: string,
		actualTokens: number,
	): void {
		const digest = this.digestMessage(message);
		const key = this.cacheKey(modelFamily, digest);
		this.cache.set(key, {
			digest,
			modelFamily,
			actualTokens,
			timestamp: Date.now(),
		});
	}

	private cacheKey(modelFamily: string, digest: string): string {
		return `${modelFamily}:${digest}`;
	}

	private serializeParts(parts: IterableLike<MessagePart>): unknown[] {
		return Array.from(parts as Iterable<MessagePart>, (part) => this.serializePart(part));
	}

	private serializePart(part: MessagePart | unknown): unknown {
		if (part instanceof vscode.LanguageModelTextPart) {
			return { type: "text", value: part.value };
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			// Include content hash to distinguish data with same size
			const contentHash = this.hashData(part.data);
			return {
				type: "data",
				mimeType: part.mimeType,
				size: part.data.byteLength,
				contentHash,
			};
		}
		if (part instanceof vscode.LanguageModelToolCallPart) {
			return {
				type: "toolCall",
				name: part.name,
				callId: part.callId,
				input: part.input,
			};
		}
		if (part instanceof vscode.LanguageModelToolResultPart) {
			return {
				type: "toolResult",
				callId: part.callId,
				content: this.serializeToolResultContent(part.content),
			};
		}
		if (this.isToolResultLike(part)) {
			const callId = typeof part.callId === "string" ? part.callId : undefined;
			return {
				type: "toolResult",
				callId,
				content: this.serializeToolResultContent(part.content),
			};
		}

		return { type: "unknown" };
	}

	private isToolResultLike(part: unknown): part is { callId?: unknown; content: unknown } {
		return (
			typeof part === "object" &&
			part !== null &&
			"content" in part &&
			(part as { content?: unknown }).content !== undefined
		);
	}

	private serializeToolResultContent(content: unknown): unknown {
		if (Array.isArray(content)) {
			return content.map((item) => this.serializePart(item as MessagePart));
		}
		if (this.isIterable(content)) {
			return Array.from(content, (item) => this.serializePart(item as MessagePart));
		}
		return content;
	}

	private isIterable(value: unknown): value is Iterable<unknown> {
		return typeof value === "object" && value !== null && Symbol.iterator in value;
	}

	/**
	 * Hash data content for digest stability.
	 * Uses first 1KB + last 1KB + size for large data to avoid hashing megabytes.
	 */
	private hashData(data: Uint8Array): string {
		const MAX_SAMPLE = 1024;
		let sample: Uint8Array;

		if (data.byteLength <= MAX_SAMPLE * 2) {
			// Small data: hash everything
			sample = data;
		} else {
			// Large data: hash first 1KB + last 1KB
			sample = new Uint8Array(MAX_SAMPLE * 2);
			sample.set(data.slice(0, MAX_SAMPLE), 0);
			sample.set(data.slice(-MAX_SAMPLE), MAX_SAMPLE);
		}

		return crypto.createHash("sha256").update(sample).digest("hex").slice(0, 16);
	}
}
