/**
 * Minimal stub provider for instant registration during activation.
 *
 * The full VercelAIChatModelProvider is heavy (imports models, tokenizer, etc).
 * This stub:
 * 1. Registers immediately (no async imports needed)
 * 2. Returns cached models from globalState for provideLanguageModelChatInformation
 * 3. Delegates provideLanguageModelChatResponse to a lazily-loaded real provider
 *
 * This ensures VS Code's model picker has our models available immediately on
 * reload, before the heavy async module loading completes.
 */
import type {
  CancellationToken,
  ExtensionContext,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelChatProvider,
  LanguageModelChatRequestMessage,
  LanguageModelResponsePart,
  Progress,
  ProvideLanguageModelChatResponseOptions,
} from "vscode";
import * as vscode from "vscode";
import type { Model } from "./models/types";
import {
  transformRawModelsToChatInfo,
  type TransformOptions,
} from "./models/transform";

/** Minimal cache shape — must match ModelsClient's PersistentModelsCache */
interface CachedModels {
  fetchedAt?: number;
  etag?: string | null;
  rawModels?: Model[];
  /** Legacy/back-compat only. Serialized model objects are not reliable. */
  models?: LanguageModelChatInformation[];
}

const MODELS_CACHE_KEY = "vercel.ai.modelsCache";

export class StubProvider
  implements LanguageModelChatProvider, vscode.Disposable
{
  private readonly context: ExtensionContext;
  private readonly modelInfoChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation =
    this.modelInfoChangeEmitter.event;

  /** The real provider, set once loaded */
  private realProvider: LanguageModelChatProvider | null = null;
  private realProviderPromise: Promise<LanguageModelChatProvider> | null = null;

  /** In-memory snapshot of cached models (stable object references). */
  private cachedModels: LanguageModelChatInformation[] = [];

  constructor(context: ExtensionContext) {
    this.context = context;

    // Hydrate from globalState so the first resolve returns models instantly.
    const cached = this.context.globalState.get<CachedModels>(MODELS_CACHE_KEY);
    if (cached?.rawModels && cached.rawModels.length > 0) {
      this.cachedModels = transformRawModelsToChatInfo(
        cached.rawModels,
        this.getTransformOptions(),
      );
    } else if (cached?.models && cached.models.length > 0) {
      // Legacy fallback — these objects may be missing picker-critical metadata.
      this.cachedModels = cached.models;
    }
  }

  /**
   * Read transform options directly from VS Code config.
   * Avoids importing the full ConfigService to keep the stub lightweight.
   */
  private getTransformOptions(): TransformOptions {
    const config = vscode.workspace.getConfiguration("vercel.ai");
    return {
      defaultModelId: config.get<string>("models.default", "") || undefined,
      userSelectable: config.get<boolean>("models.showAll", false),
    };
  }

  /** Connect to the full provider once it's loaded */
  setRealProvider(provider: LanguageModelChatProvider): void {
    this.realProvider = provider;
  }

  /** Set a promise that resolves to the real provider (for delegation) */
  setRealProviderPromise(promise: Promise<LanguageModelChatProvider>): void {
    this.realProviderPromise = promise;
  }

  /** Fire change event to trigger VS Code model resolution */
  notifyModelsAvailable(): void {
    this.modelInfoChangeEmitter.fire();
  }

  dispose(): void {
    this.modelInfoChangeEmitter.dispose();
  }

  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    // Refresh from globalState in case the real provider updated it.
    const cached = this.context.globalState.get<CachedModels>(MODELS_CACHE_KEY);
    if (cached?.rawModels && cached.rawModels.length > 0) {
      this.cachedModels = transformRawModelsToChatInfo(
        cached.rawModels,
        this.getTransformOptions(),
      );
    } else if (cached?.models && cached.models.length > 0) {
      this.cachedModels = cached.models;
    }

    // If we have cached models, return them immediately — this is the whole
    // point of the stub: instant model availability without blocking on auth
    // or network.
    if (this.cachedModels.length > 0) {
      return this.cachedModels;
    }

    // First-run fallback: no persisted cache exists (clean profile).
    // Delegate to the real provider so users can ever see Vercel models.
    if (this.realProvider) {
      const delegated =
        await this.realProvider.provideLanguageModelChatInformation(
          options,
          _token,
        );
      if (delegated && delegated.length > 0) {
        this.cachedModels = delegated;
        return delegated;
      }
    }

    return [];
  }

  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    // Wait for real provider if not yet loaded
    if (!this.realProvider && this.realProviderPromise) {
      this.realProvider = await this.realProviderPromise;
    }

    if (!this.realProvider) {
      throw new Error("Provider not yet initialized");
    }

    return this.realProvider.provideLanguageModelChatResponse(
      model,
      messages,
      options,
      progress,
      token,
    );
  }

  /**
   * Token counting — VS Code calls this on the registered provider to estimate
   * message sizes for context-window management. Delegate to the real provider
   * when available; fall back to a rough chars/4 heuristic otherwise.
   */
  provideTokenCount(
    model: LanguageModelChatInformation,
    text: string | LanguageModelChatMessage,
    token: CancellationToken,
  ): Thenable<number> {
    const getProvider = async (): Promise<LanguageModelChatProvider | null> => {
      if (!this.realProvider && this.realProviderPromise) {
        this.realProvider = await this.realProviderPromise;
      }
      return this.realProvider;
    };

    return getProvider().then((provider) => {
      if (provider && "provideTokenCount" in provider) {
        return (
          provider as unknown as {
            provideTokenCount(
              model: LanguageModelChatInformation,
              text: string | LanguageModelChatMessage,
              token: CancellationToken,
            ): Thenable<number>;
          }
        ).provideTokenCount(model, text, token);
      }

      // Rough fallback: ~4 chars per token
      if (typeof text === "string") {
        return Math.ceil(text.length / 4);
      }
      let len = 0;
      for (const part of text.content) {
        if ("value" in part && typeof part.value === "string") {
          len += part.value.length;
        } else if ("text" in part && typeof part.text === "string") {
          len += part.text.length;
        }
      }
      return Math.ceil(len / 4);
    });
  }
}
