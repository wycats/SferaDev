## Findings: countTokens( in workbench
### Files Found
- [.reference/vscode/src/vs/workbench/api/common/extHostLanguageModels.ts](.reference/vscode/src/vs/workbench/api/common/extHostLanguageModels.ts#L418)
- [.reference/vscode/src/vs/workbench/api/common/extHostLanguageModels.ts](.reference/vscode/src/vs/workbench/api/common/extHostLanguageModels.ts#L584)
- [.reference/vscode/src/vs/workbench/api/common/extHost.protocol.ts](.reference/vscode/src/vs/workbench/api/common/extHost.protocol.ts#L1341)
- [.reference/vscode/src/vs/workbench/api/browser/mainThreadLanguageModels.ts](.reference/vscode/src/vs/workbench/api/browser/mainThreadLanguageModels.ts#L182)
- [.reference/vscode/src/vs/workbench/api/browser/mainThreadLanguageModelTools.ts](.reference/vscode/src/vs/workbench/api/browser/mainThreadLanguageModelTools.ts#L84)

### Code Excerpts

#### [.reference/vscode/src/vs/workbench/api/common/extHostLanguageModels.ts](.reference/vscode/src/vs/workbench/api/common/extHostLanguageModels.ts#L398-L438)

```
		// make sure auth information is correct
		if (this._isUsingAuth(extension.identifier, model.metadata)) {
			await this._fakeAuthPopulate(model.metadata);
		}

		let apiObject: vscode.LanguageModelChat | undefined;
		if (!apiObject) {
			const that = this;
			apiObject = {
				id: model.info.id,
				vendor: model.metadata.vendor,
				family: model.info.family,
				version: model.info.version,
				name: model.info.name,
				capabilities: {
					supportsImageToText: model.metadata.capabilities?.vision ?? false,
					supportsToolCalling: !!model.metadata.capabilities?.toolCalling,
					editToolsHint: model.metadata.capabilities?.editTools,
				},
				maxInputTokens: model.metadata.maxInputTokens,
				countTokens(text, token) {
					if (!that._localModels.has(modelId)) {
						throw extHostTypes.LanguageModelError.NotFound(modelId);
					}
					return that._computeTokenLength(modelId, text, token ?? CancellationToken.None);
				},
				sendRequest(messages, options, token) {
					if (!that._localModels.has(modelId)) {
						throw extHostTypes.LanguageModelError.NotFound(modelId);
					}
					return that._sendChatRequest(extension, modelId, messages, options ?? {}, token ?? CancellationToken.None);
				}
			};

			Object.freeze(apiObject);
		}

		return apiObject;
	}

	async selectLanguageModels(extension: IExtensionDescription, selector: vscode.LanguageModelChatSelector) {
```

#### [.reference/vscode/src/vs/workbench/api/common/extHostLanguageModels.ts](.reference/vscode/src/vs/workbench/api/common/extHostLanguageModels.ts#L564-L604)

```
			return;
		}

		for (const from of this._languageAccessInformationExtensions) {
			try {
				await this._getAuthAccess(from, { identifier: metadata.extension, displayName: '' }, undefined, true);
			} catch (err) {
				this._logService.error('Fake Auth request failed');
				this._logService.error(err);
			}
		}
	}

	private async _computeTokenLength(modelId: string, value: string | vscode.LanguageModelChatMessage2, token: vscode.CancellationToken): Promise<number> {

		const data = this._localModels.get(modelId);
		if (!data) {
			throw extHostTypes.LanguageModelError.NotFound(`Language model '${modelId}' is unknown.`);
		}
		return this._languageModelProviders.get(data.metadata.vendor)?.provider.provideTokenCount(data.info, value, token) ?? 0;
		// return this._proxy.$countTokens(languageModelId, (typeof value === 'string' ? value : typeConvert.LanguageModelChatMessage2.from(value)), token);
	}

	$updateModelAccesslist(data: { from: ExtensionIdentifier; to: ExtensionIdentifier; enabled: boolean }[]): void {
		const updated = new Array<{ from: ExtensionIdentifier; to: ExtensionIdentifier }>();
		for (const { from, to, enabled } of data) {
			const set = this._modelAccessList.get(from) ?? new ExtensionIdentifierSet();
			const oldValue = set.has(to);
			if (oldValue !== enabled) {
				if (enabled) {
					set.add(to);
				} else {
					set.delete(to);
				}
				this._modelAccessList.set(from, set);
				const newItem = { from, to };
				updated.push(newItem);
				this._onDidChangeModelAccess.fire(newItem);
			}
		}
	}
```

#### [.reference/vscode/src/vs/workbench/api/common/extHost.protocol.ts](.reference/vscode/src/vs/workbench/api/common/extHost.protocol.ts#L1321-L1361)

```
export interface ExtHostSpeechShape {
	$createSpeechToTextSession(handle: number, session: number, language?: string): Promise<void>;
	$cancelSpeechToTextSession(session: number): Promise<void>;

	$createTextToSpeechSession(handle: number, session: number, language?: string): Promise<void>;
	$synthesizeSpeech(session: number, text: string): Promise<void>;
	$cancelTextToSpeechSession(session: number): Promise<void>;

	$createKeywordRecognitionSession(handle: number, session: number): Promise<void>;
	$cancelKeywordRecognitionSession(session: number): Promise<void>;
}

export interface MainThreadLanguageModelsShape extends IDisposable {
	$registerLanguageModelProvider(vendor: string): void;
	$onLMProviderChange(vendor: string): void;
	$unregisterProvider(vendor: string): void;
	$tryStartChatRequest(extension: ExtensionIdentifier, modelIdentifier: string, requestId: number, messages: SerializableObjectWithBuffers<IChatMessage[]>, options: {}, token: CancellationToken): Promise<void>;
	$reportResponsePart(requestId: number, chunk: SerializableObjectWithBuffers<IChatResponsePart | IChatResponsePart[]>): Promise<void>;
	$reportResponseDone(requestId: number, error: SerializedError | undefined): Promise<void>;
	$selectChatModels(selector: ILanguageModelChatSelector): Promise<string[]>;
	$countTokens(modelId: string, value: string | IChatMessage, token: CancellationToken): Promise<number>;
	$fileIsIgnored(uri: UriComponents, token: CancellationToken): Promise<boolean>;
	$registerFileIgnoreProvider(handle: number): void;
	$unregisterFileIgnoreProvider(handle: number): void;
}

export interface ExtHostLanguageModelsShape {
	$provideLanguageModelChatInfo(vendor: string, options: ILanguageModelChatInfoOptions, token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]>;
	$updateModelAccesslist(data: { from: ExtensionIdentifier; to: ExtensionIdentifier; enabled: boolean }[]): void;
	$startChatRequest(modelId: string, requestId: number, from: ExtensionIdentifier, messages: SerializableObjectWithBuffers<IChatMessage[]>, options: { [name: string]: any }, token: CancellationToken): Promise<void>;
	$acceptResponsePart(requestId: number, chunk: SerializableObjectWithBuffers<IChatResponsePart | IChatResponsePart[]>): Promise<void>;
	$acceptResponseDone(requestId: number, error: SerializedError | undefined): Promise<void>;
	$provideTokenLength(modelId: string, value: string | IChatMessage, token: CancellationToken): Promise<number>;
	$isFileIgnored(handle: number, uri: UriComponents, token: CancellationToken): Promise<boolean>;
}

export interface ExtHostChatContextShape {
	$provideWorkspaceChatContext(handle: number, token: CancellationToken): Promise<IChatContextItem[]>;
	$provideExplicitChatContext(handle: number, token: CancellationToken): Promise<IChatContextItem[]>;
	$resolveExplicitChatContext(handle: number, context: IChatContextItem, token: CancellationToken): Promise<IChatContextItem>;
	$provideResourceChatContext(handle: number, options: { resource: UriComponents; withValue: boolean }, token: CancellationToken): Promise<IChatContextItem | undefined>;
```

#### [.reference/vscode/src/vs/workbench/api/browser/mainThreadLanguageModels.ts](.reference/vscode/src/vs/workbench/api/browser/mainThreadLanguageModels.ts#L162-L202)

```
					await this._proxy.$acceptResponsePart(requestId, new SerializableObjectWithBuffers(part));
				}
				this._logService.trace('[CHAT] request DONE', extension.value, requestId);
			} catch (err) {
				this._logService.error('[CHAT] extension request ERRORED in STREAM', toErrorMessage(err, true), extension.value, requestId);
				this._proxy.$acceptResponseDone(requestId, transformErrorForSerialization(err));
			}
		})();

		// When the response is done (signaled via its result) we tell the EH
		Promise.allSettled([response.result, streaming]).then(() => {
			this._logService.debug('[CHAT] extension request DONE', extension.value, requestId);
			this._proxy.$acceptResponseDone(requestId, undefined);
		}, err => {
			this._logService.error('[CHAT] extension request ERRORED', toErrorMessage(err, true), extension.value, requestId);
			this._proxy.$acceptResponseDone(requestId, transformErrorForSerialization(err));
		});
	}


	$countTokens(modelId: string, value: string | IChatMessage, token: CancellationToken): Promise<number> {
		return this._chatProviderService.computeTokenLength(modelId, value, token);
	}

	private _registerAuthenticationProvider(extension: ExtensionIdentifier, auth: { providerLabel: string; accountLabel?: string | undefined }): IDisposable {
		// This needs to be done in both MainThread & ExtHost ChatProvider
		const authProviderId = INTERNAL_AUTH_PROVIDER_PREFIX + extension.value;

		// Only register one auth provider per extension
		if (this._authenticationService.getProviderIds().includes(authProviderId)) {
			return Disposable.None;
		}

		const accountLabel = auth.accountLabel ?? localize('languageModelsAccountId', 'Language Models');
		const disposables = new DisposableStore();
		this._authenticationService.registerAuthenticationProvider(authProviderId, new LanguageModelAccessAuthProvider(authProviderId, auth.providerLabel, accountLabel));
		disposables.add(toDisposable(() => {
			this._authenticationService.unregisterAuthenticationProvider(authProviderId);
		}));
		disposables.add(this._authenticationAccessService.onDidChangeExtensionSessionAccess(async (e) => {
			const allowedExtensions = this._authenticationAccessService.readAllowedExtensions(authProviderId, accountLabel);
```

#### [.reference/vscode/src/vs/workbench/api/browser/mainThreadLanguageModelTools.ts](.reference/vscode/src/vs/workbench/api/browser/mainThreadLanguageModelTools.ts#L64-L104)

```
		);

		// Only return content and metadata to EH
		const out: Dto<IToolResult> = {
			content: result.content,
			toolMetadata: result.toolMetadata
		};
		return toolResultHasBuffers(result) ? new SerializableObjectWithBuffers(out) : out;
	}

	$acceptToolProgress(callId: string, progress: IToolProgressStep): void {
		this._runningToolCalls.get(callId)?.progress.report(progress);
	}

	$countTokensForInvocation(callId: string, input: string, token: CancellationToken): Promise<number> {
		const fn = this._runningToolCalls.get(callId);
		if (!fn) {
			throw new Error(`Tool invocation call ${callId} not found`);
		}

		return fn.countTokens(input, token);
	}

	$registerTool(id: string, hasHandleToolStream: boolean): void {
		const disposable = this._languageModelToolsService.registerToolImplementation(
			id,
			{
				invoke: async (dto, countTokens, progress, token) => {
					try {
						this._runningToolCalls.set(dto.callId, { countTokens, progress });
						const resultSerialized = await this._proxy.$invokeTool(dto, token);
						const resultDto: Dto<IToolResult> = resultSerialized instanceof SerializableObjectWithBuffers ? resultSerialized.value : resultSerialized;
						return revive<IToolResult>(resultDto);
					} finally {
						this._runningToolCalls.delete(dto.callId);
					}
				},
				prepareToolInvocation: (context, token) => this._proxy.$prepareToolInvocation(id, context, token),
				handleToolStream: hasHandleToolStream ? (context, token) => this._proxy.$handleToolStream(id, context, token) : undefined,
			});
		this._tools.set(id, disposable);
```
