import type * as vscode from "vscode";
import { logger } from "../logger";
import { computeNormalizedDigest } from "../utils/digest";

export interface CachedTokenCount {
  digest: string;
  modelFamily: string;
  actualTokens: number;
  timestamp: number;
}

export class TokenCache {
  private cache = new Map<string, CachedTokenCount>();

  getCached(
    message: vscode.LanguageModelChatMessage,
    modelFamily: string,
  ): number | undefined {
    const digest = computeNormalizedDigest(message);
    const key = this.cacheKey(modelFamily, digest);
    const cached = this.cache.get(key)?.actualTokens;
    if (cached !== undefined) {
      logger.trace(
        `Token cache hit for message (family: ${modelFamily}): ${cached.toString()} tokens`,
      );
      return cached;
    }
    logger.trace(`Token cache miss for message (family: ${modelFamily})`);
    return undefined;
  }

  cacheActual(
    message: vscode.LanguageModelChatMessage,
    modelFamily: string,
    actualTokens: number,
  ): void {
    const digest = computeNormalizedDigest(message);
    const key = this.cacheKey(modelFamily, digest);
    this.cache.set(key, {
      digest,
      modelFamily,
      actualTokens,
      timestamp: Date.now(),
    });
    logger.trace(
      `Cached actual token count: ${actualTokens.toString()} (family: ${modelFamily})`,
    );
  }

  private cacheKey(modelFamily: string, digest: string): string {
    return `${modelFamily}:${digest}`;
  }
}
