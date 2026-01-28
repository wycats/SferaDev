import { getEncoding } from "js-tiktoken";
import * as vscode from "vscode";

type Encoding = {
	encode: (text: string) => number[];
	free?: () => void;
};

const FALLBACK_CHARS_PER_TOKEN = 3.5;

export class TokenCounter {
	private encodings = new Map<string, Encoding>();

	estimateTextTokens(text: string, modelFamily: string): number {
		if (!text) return 0;
		const encoding = this.getEncodingForFamily(modelFamily);
		if (encoding) {
			return encoding.encode(text).length;
		}
		return this.estimateByChars(text);
	}

	estimateMessageTokens(message: vscode.LanguageModelChatMessage, modelFamily: string): number {
		let total = 0;
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += this.estimateTextTokens(part.value, modelFamily);
			} else if (part instanceof vscode.LanguageModelDataPart) {
				if (part.mimeType.startsWith("image/")) {
					total += this.estimateImageTokens(modelFamily, part);
				} else {
					const decoded = new TextDecoder().decode(part.data);
					total += this.estimateTextTokens(decoded, modelFamily);
				}
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				total += this.estimateToolCallTokens(part, modelFamily);
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				total += this.estimateToolResultTokens(part, modelFamily);
			}
		}
		return total;
	}

	applySafetyMargin(tokens: number, margin: number): number {
		return Math.ceil(tokens * (1 + margin));
	}

	usesCharacterFallback(modelFamily: string): boolean {
		return this.getEncodingForFamily(modelFamily) === undefined;
	}

	private estimateByChars(text: string): number {
		return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
	}

	private estimateToolCallTokens(
		part: vscode.LanguageModelToolCallPart,
		modelFamily: string,
	): number {
		const inputJson = JSON.stringify(part.input ?? {});
		const payload = `${part.name}\n${inputJson}`;
		return this.estimateTextTokens(payload, modelFamily) + 4;
	}

	private estimateToolResultTokens(
		part: vscode.LanguageModelToolResultPart,
		modelFamily: string,
	): number {
		let total = this.estimateTextTokens(part.callId ?? "", modelFamily) + 4;
		for (const resultPart of part.content) {
			if (typeof resultPart === "object" && resultPart !== null && "value" in resultPart) {
				total += this.estimateTextTokens(String(resultPart.value), modelFamily);
			}
		}
		return total;
	}

	private estimateImageTokens(
		modelFamily: string,
		imagePart: vscode.LanguageModelDataPart,
	): number {
		const family = modelFamily.toLowerCase();

		if (family.includes("anthropic") || family.includes("claude")) {
			return 1600;
		}

		const dataSize = imagePart.data.byteLength;
		const estimatedPixels = dataSize / 3;
		const estimatedDimension = Math.sqrt(estimatedPixels);
		const scaledDimension = Math.min(estimatedDimension, 2048);
		const tilesPerSide = Math.ceil(scaledDimension / 512);
		const totalTiles = tilesPerSide * tilesPerSide;
		const openAITokens = 85 + totalTiles * 85;

		return Math.min(openAITokens, 1700);
	}

	private getEncodingForFamily(modelFamily: string): Encoding | undefined {
		const encodingName = this.resolveEncodingName(modelFamily);
		if (this.encodings.has(encodingName)) {
			return this.encodings.get(encodingName);
		}
		try {
			const encoding = getEncoding(encodingName) as Encoding;
			this.encodings.set(encodingName, encoding);
			return encoding;
		} catch {
			return undefined;
		}
	}

	private resolveEncodingName(modelFamily: string): "o200k_base" | "cl100k_base" {
		const family = modelFamily.toLowerCase();
		if (family.includes("gpt-4o") || family.includes("o1")) {
			return "o200k_base";
		}
		return "cl100k_base";
	}
}
