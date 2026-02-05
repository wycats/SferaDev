## Findings: maxInputTokens in chat contrib
### Files Found
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L217)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L219)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L226)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L228)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L234)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L73)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L76)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L77)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L619)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L622)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L626)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L628)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L1136)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L1137)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts#L25)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts#L106)
- [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts#L113)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L72)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L84)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L147)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L333)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L441)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L588)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L613)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L657)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L687)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L691)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L711)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L758)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L798)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L829)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L846)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L171)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L192)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L213)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L234)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L551)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L573)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L657)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L686)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L798)
- [.reference/vscode/src/vs/workbench/contrib/chat/common/languageModels.ts](.reference/vscode/src/vs/workbench/contrib/chat/common/languageModels.ts#L180)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts#L116)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts#L117)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts#L118)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts#L56)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts#L57)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts#L58)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHovers.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHovers.test.ts#L56)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHovers.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHovers.test.ts#L57)

### Code Excerpts

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L197-L237)

```
		if (!lastRequest?.response || !lastRequest.modelId) {
			this.hide();
			return;
		}

		const response = lastRequest.response;
		const modelId = lastRequest.modelId;

		// Update immediately if usage data is already available
		this.updateFromResponse(response, modelId);

		// Subscribe to response changes to update whenever usage data changes
		this._lastRequestDisposable.value = response.onDidChange(() => {
			this.updateFromResponse(response, modelId);
		});
	}

	private updateFromResponse(response: IChatResponseModel, modelId: string): void {
		const usage = response.usage;
		const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
		const maxInputTokens = modelMetadata?.maxInputTokens;

		if (!usage || !maxInputTokens || maxInputTokens <= 0) {
			this.hide();
			return;
		}

		const promptTokens = usage.promptTokens;
		const promptTokenDetails = usage.promptTokenDetails;
		const percentage = Math.min(100, (promptTokens / maxInputTokens) * 100);

		this.render(percentage, promptTokens, maxInputTokens, promptTokenDetails);
		this.show();
	}

	private render(percentage: number, promptTokens: number, maxTokens: number, promptTokenDetails?: readonly { category: string; label: string; percentageOfPrompt: number }[]): void {
		// Store current data for use in details popup
		this.currentData = { promptTokens, maxInputTokens: maxTokens, percentage, promptTokenDetails };

		// Update pie chart progress
		this.progressIndicator.setProgress(percentage);
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L199-L239)

```
			return;
		}

		const response = lastRequest.response;
		const modelId = lastRequest.modelId;

		// Update immediately if usage data is already available
		this.updateFromResponse(response, modelId);

		// Subscribe to response changes to update whenever usage data changes
		this._lastRequestDisposable.value = response.onDidChange(() => {
			this.updateFromResponse(response, modelId);
		});
	}

	private updateFromResponse(response: IChatResponseModel, modelId: string): void {
		const usage = response.usage;
		const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
		const maxInputTokens = modelMetadata?.maxInputTokens;

		if (!usage || !maxInputTokens || maxInputTokens <= 0) {
			this.hide();
			return;
		}

		const promptTokens = usage.promptTokens;
		const promptTokenDetails = usage.promptTokenDetails;
		const percentage = Math.min(100, (promptTokens / maxInputTokens) * 100);

		this.render(percentage, promptTokens, maxInputTokens, promptTokenDetails);
		this.show();
	}

	private render(percentage: number, promptTokens: number, maxTokens: number, promptTokenDetails?: readonly { category: string; label: string; percentageOfPrompt: number }[]): void {
		// Store current data for use in details popup
		this.currentData = { promptTokens, maxInputTokens: maxTokens, percentage, promptTokenDetails };

		// Update pie chart progress
		this.progressIndicator.setProgress(percentage);

		// Update color based on usage level
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L206-L246)

```
		this.updateFromResponse(response, modelId);

		// Subscribe to response changes to update whenever usage data changes
		this._lastRequestDisposable.value = response.onDidChange(() => {
			this.updateFromResponse(response, modelId);
		});
	}

	private updateFromResponse(response: IChatResponseModel, modelId: string): void {
		const usage = response.usage;
		const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
		const maxInputTokens = modelMetadata?.maxInputTokens;

		if (!usage || !maxInputTokens || maxInputTokens <= 0) {
			this.hide();
			return;
		}

		const promptTokens = usage.promptTokens;
		const promptTokenDetails = usage.promptTokenDetails;
		const percentage = Math.min(100, (promptTokens / maxInputTokens) * 100);

		this.render(percentage, promptTokens, maxInputTokens, promptTokenDetails);
		this.show();
	}

	private render(percentage: number, promptTokens: number, maxTokens: number, promptTokenDetails?: readonly { category: string; label: string; percentageOfPrompt: number }[]): void {
		// Store current data for use in details popup
		this.currentData = { promptTokens, maxInputTokens: maxTokens, percentage, promptTokenDetails };

		// Update pie chart progress
		this.progressIndicator.setProgress(percentage);

		// Update color based on usage level
		this.domNode.classList.remove('warning', 'error');
		if (percentage >= 90) {
			this.domNode.classList.add('error');
		} else if (percentage >= 75) {
			this.domNode.classList.add('warning');
		}
	}
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L208-L248)

```
		// Subscribe to response changes to update whenever usage data changes
		this._lastRequestDisposable.value = response.onDidChange(() => {
			this.updateFromResponse(response, modelId);
		});
	}

	private updateFromResponse(response: IChatResponseModel, modelId: string): void {
		const usage = response.usage;
		const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
		const maxInputTokens = modelMetadata?.maxInputTokens;

		if (!usage || !maxInputTokens || maxInputTokens <= 0) {
			this.hide();
			return;
		}

		const promptTokens = usage.promptTokens;
		const promptTokenDetails = usage.promptTokenDetails;
		const percentage = Math.min(100, (promptTokens / maxInputTokens) * 100);

		this.render(percentage, promptTokens, maxInputTokens, promptTokenDetails);
		this.show();
	}

	private render(percentage: number, promptTokens: number, maxTokens: number, promptTokenDetails?: readonly { category: string; label: string; percentageOfPrompt: number }[]): void {
		// Store current data for use in details popup
		this.currentData = { promptTokens, maxInputTokens: maxTokens, percentage, promptTokenDetails };

		// Update pie chart progress
		this.progressIndicator.setProgress(percentage);

		// Update color based on usage level
		this.domNode.classList.remove('warning', 'error');
		if (percentage >= 90) {
			this.domNode.classList.add('error');
		} else if (percentage >= 75) {
			this.domNode.classList.add('warning');
		}
	}

	private show(): void {
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageWidget.ts#L214-L254)

```
	private updateFromResponse(response: IChatResponseModel, modelId: string): void {
		const usage = response.usage;
		const modelMetadata = this.languageModelsService.lookupLanguageModel(modelId);
		const maxInputTokens = modelMetadata?.maxInputTokens;

		if (!usage || !maxInputTokens || maxInputTokens <= 0) {
			this.hide();
			return;
		}

		const promptTokens = usage.promptTokens;
		const promptTokenDetails = usage.promptTokenDetails;
		const percentage = Math.min(100, (promptTokens / maxInputTokens) * 100);

		this.render(percentage, promptTokens, maxInputTokens, promptTokenDetails);
		this.show();
	}

	private render(percentage: number, promptTokens: number, maxTokens: number, promptTokenDetails?: readonly { category: string; label: string; percentageOfPrompt: number }[]): void {
		// Store current data for use in details popup
		this.currentData = { promptTokens, maxInputTokens: maxTokens, percentage, promptTokenDetails };

		// Update pie chart progress
		this.progressIndicator.setProgress(percentage);

		// Update color based on usage level
		this.domNode.classList.remove('warning', 'error');
		if (percentage >= 90) {
			this.domNode.classList.add('error');
		} else if (percentage >= 75) {
			this.domNode.classList.add('warning');
		}
	}

	private show(): void {
		if (this.domNode.style.display === 'none') {
			this.domNode.style.display = '';
			this._isVisible.set(true, undefined);
			this._onDidChangeVisibility.fire();
		}
	}
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L53-L93)

```
		markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${model.metadata.id}@${model.metadata.version}_&nbsp;</span>`);
	} else {
		markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${model.metadata.id}_&nbsp;</span>`);
	}
	markdown.appendText(`\n`);

	if (model.metadata.statusIcon && model.metadata.tooltip) {
		if (model.metadata.statusIcon) {
			markdown.appendMarkdown(`$(${model.metadata.statusIcon.id})&nbsp;`);
		}
		markdown.appendMarkdown(`${model.metadata.tooltip}`);
		markdown.appendText(`\n`);
	}

	if (model.metadata.multiplier) {
		markdown.appendMarkdown(`${localize('models.cost', 'Multiplier')}: `);
		markdown.appendMarkdown(model.metadata.multiplier);
		markdown.appendText(`\n`);
	}

	if (model.metadata.maxInputTokens || model.metadata.maxOutputTokens) {
		markdown.appendMarkdown(`${localize('models.contextSize', 'Context Size')}: `);
		let addSeparator = false;
		if (model.metadata.maxInputTokens) {
			markdown.appendMarkdown(`$(arrow-down) ${formatTokenCount(model.metadata.maxInputTokens)} (${localize('models.input', 'Input')})`);
			addSeparator = true;
		}
		if (model.metadata.maxOutputTokens) {
			if (addSeparator) {
				markdown.appendText(`  |  `);
			}
			markdown.appendMarkdown(`$(arrow-up) ${formatTokenCount(model.metadata.maxOutputTokens)} (${localize('models.output', 'Output')})`);
		}
		markdown.appendText(`\n`);
	}

	if (model.metadata.capabilities) {
		markdown.appendMarkdown(`${localize('models.capabilities', 'Capabilities')}: `);
		if (model.metadata.capabilities?.toolCalling) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${localize('models.toolCalling', 'Tools')}_&nbsp;</span>`);
		}
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L56-L96)

```
	}
	markdown.appendText(`\n`);

	if (model.metadata.statusIcon && model.metadata.tooltip) {
		if (model.metadata.statusIcon) {
			markdown.appendMarkdown(`$(${model.metadata.statusIcon.id})&nbsp;`);
		}
		markdown.appendMarkdown(`${model.metadata.tooltip}`);
		markdown.appendText(`\n`);
	}

	if (model.metadata.multiplier) {
		markdown.appendMarkdown(`${localize('models.cost', 'Multiplier')}: `);
		markdown.appendMarkdown(model.metadata.multiplier);
		markdown.appendText(`\n`);
	}

	if (model.metadata.maxInputTokens || model.metadata.maxOutputTokens) {
		markdown.appendMarkdown(`${localize('models.contextSize', 'Context Size')}: `);
		let addSeparator = false;
		if (model.metadata.maxInputTokens) {
			markdown.appendMarkdown(`$(arrow-down) ${formatTokenCount(model.metadata.maxInputTokens)} (${localize('models.input', 'Input')})`);
			addSeparator = true;
		}
		if (model.metadata.maxOutputTokens) {
			if (addSeparator) {
				markdown.appendText(`  |  `);
			}
			markdown.appendMarkdown(`$(arrow-up) ${formatTokenCount(model.metadata.maxOutputTokens)} (${localize('models.output', 'Output')})`);
		}
		markdown.appendText(`\n`);
	}

	if (model.metadata.capabilities) {
		markdown.appendMarkdown(`${localize('models.capabilities', 'Capabilities')}: `);
		if (model.metadata.capabilities?.toolCalling) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${localize('models.toolCalling', 'Tools')}_&nbsp;</span>`);
		}
		if (model.metadata.capabilities?.vision) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${localize('models.vision', 'Vision')}_&nbsp;</span>`);
		}
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L57-L97)

```
	markdown.appendText(`\n`);

	if (model.metadata.statusIcon && model.metadata.tooltip) {
		if (model.metadata.statusIcon) {
			markdown.appendMarkdown(`$(${model.metadata.statusIcon.id})&nbsp;`);
		}
		markdown.appendMarkdown(`${model.metadata.tooltip}`);
		markdown.appendText(`\n`);
	}

	if (model.metadata.multiplier) {
		markdown.appendMarkdown(`${localize('models.cost', 'Multiplier')}: `);
		markdown.appendMarkdown(model.metadata.multiplier);
		markdown.appendText(`\n`);
	}

	if (model.metadata.maxInputTokens || model.metadata.maxOutputTokens) {
		markdown.appendMarkdown(`${localize('models.contextSize', 'Context Size')}: `);
		let addSeparator = false;
		if (model.metadata.maxInputTokens) {
			markdown.appendMarkdown(`$(arrow-down) ${formatTokenCount(model.metadata.maxInputTokens)} (${localize('models.input', 'Input')})`);
			addSeparator = true;
		}
		if (model.metadata.maxOutputTokens) {
			if (addSeparator) {
				markdown.appendText(`  |  `);
			}
			markdown.appendMarkdown(`$(arrow-up) ${formatTokenCount(model.metadata.maxOutputTokens)} (${localize('models.output', 'Output')})`);
		}
		markdown.appendText(`\n`);
	}

	if (model.metadata.capabilities) {
		markdown.appendMarkdown(`${localize('models.capabilities', 'Capabilities')}: `);
		if (model.metadata.capabilities?.toolCalling) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${localize('models.toolCalling', 'Tools')}_&nbsp;</span>`);
		}
		if (model.metadata.capabilities?.vision) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${localize('models.vision', 'Vision')}_&nbsp;</span>`);
		}
		if (model.metadata.capabilities?.agentMode) {
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L599-L639)

```
			tokenLimitsElement,
			disposables,
			elementDisposables
		};
	}

	override renderElement(entry: IViewModelEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
		DOM.clearNode(templateData.tokenLimitsElement);
		super.renderElement(entry, index, templateData);
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
		const { model: modelEntry } = entry;
		const markdown = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		if (modelEntry.metadata.maxInputTokens || modelEntry.metadata.maxOutputTokens) {
			let addSeparator = false;
			markdown.appendMarkdown(`${localize('models.contextSize', 'Context Size')}: `);
			if (modelEntry.metadata.maxInputTokens) {
				const inputDiv = DOM.append(templateData.tokenLimitsElement, $('.token-limit-item'));
				DOM.append(inputDiv, $('span.codicon.codicon-arrow-down'));
				const inputText = DOM.append(inputDiv, $('span'));
				inputText.textContent = formatTokenCount(modelEntry.metadata.maxInputTokens);

				markdown.appendMarkdown(`$(arrow-down) ${modelEntry.metadata.maxInputTokens} (${localize('models.input', 'Input')})`);
				addSeparator = true;
			}
			if (modelEntry.metadata.maxOutputTokens) {
				const outputDiv = DOM.append(templateData.tokenLimitsElement, $('.token-limit-item'));
				DOM.append(outputDiv, $('span.codicon.codicon-arrow-up'));
				const outputText = DOM.append(outputDiv, $('span'));
				outputText.textContent = formatTokenCount(modelEntry.metadata.maxOutputTokens);
				if (addSeparator) {
					markdown.appendText(`  |  `);
				}
				markdown.appendMarkdown(`$(arrow-up) ${modelEntry.metadata.maxOutputTokens} (${localize('models.output', 'Output')})`);
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L602-L642)

```
		};
	}

	override renderElement(entry: IViewModelEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
		DOM.clearNode(templateData.tokenLimitsElement);
		super.renderElement(entry, index, templateData);
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
		const { model: modelEntry } = entry;
		const markdown = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		if (modelEntry.metadata.maxInputTokens || modelEntry.metadata.maxOutputTokens) {
			let addSeparator = false;
			markdown.appendMarkdown(`${localize('models.contextSize', 'Context Size')}: `);
			if (modelEntry.metadata.maxInputTokens) {
				const inputDiv = DOM.append(templateData.tokenLimitsElement, $('.token-limit-item'));
				DOM.append(inputDiv, $('span.codicon.codicon-arrow-down'));
				const inputText = DOM.append(inputDiv, $('span'));
				inputText.textContent = formatTokenCount(modelEntry.metadata.maxInputTokens);

				markdown.appendMarkdown(`$(arrow-down) ${modelEntry.metadata.maxInputTokens} (${localize('models.input', 'Input')})`);
				addSeparator = true;
			}
			if (modelEntry.metadata.maxOutputTokens) {
				const outputDiv = DOM.append(templateData.tokenLimitsElement, $('.token-limit-item'));
				DOM.append(outputDiv, $('span.codicon.codicon-arrow-up'));
				const outputText = DOM.append(outputDiv, $('span'));
				outputText.textContent = formatTokenCount(modelEntry.metadata.maxOutputTokens);
				if (addSeparator) {
					markdown.appendText(`  |  `);
				}
				markdown.appendMarkdown(`$(arrow-up) ${modelEntry.metadata.maxOutputTokens} (${localize('models.output', 'Output')})`);
			}
		}

```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L606-L646)

```
		DOM.clearNode(templateData.tokenLimitsElement);
		super.renderElement(entry, index, templateData);
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
		const { model: modelEntry } = entry;
		const markdown = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		if (modelEntry.metadata.maxInputTokens || modelEntry.metadata.maxOutputTokens) {
			let addSeparator = false;
			markdown.appendMarkdown(`${localize('models.contextSize', 'Context Size')}: `);
			if (modelEntry.metadata.maxInputTokens) {
				const inputDiv = DOM.append(templateData.tokenLimitsElement, $('.token-limit-item'));
				DOM.append(inputDiv, $('span.codicon.codicon-arrow-down'));
				const inputText = DOM.append(inputDiv, $('span'));
				inputText.textContent = formatTokenCount(modelEntry.metadata.maxInputTokens);

				markdown.appendMarkdown(`$(arrow-down) ${modelEntry.metadata.maxInputTokens} (${localize('models.input', 'Input')})`);
				addSeparator = true;
			}
			if (modelEntry.metadata.maxOutputTokens) {
				const outputDiv = DOM.append(templateData.tokenLimitsElement, $('.token-limit-item'));
				DOM.append(outputDiv, $('span.codicon.codicon-arrow-up'));
				const outputText = DOM.append(outputDiv, $('span'));
				outputText.textContent = formatTokenCount(modelEntry.metadata.maxOutputTokens);
				if (addSeparator) {
					markdown.appendText(`  |  `);
				}
				markdown.appendMarkdown(`$(arrow-up) ${modelEntry.metadata.maxOutputTokens} (${localize('models.output', 'Output')})`);
			}
		}

		templateData.elementDisposables.add(this.hoverService.setupDelayedHoverAtMouse(templateData.container, () => ({
			content: markdown,
			appearance: {
				compact: true,
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L608-L648)

```
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
		const { model: modelEntry } = entry;
		const markdown = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		if (modelEntry.metadata.maxInputTokens || modelEntry.metadata.maxOutputTokens) {
			let addSeparator = false;
			markdown.appendMarkdown(`${localize('models.contextSize', 'Context Size')}: `);
			if (modelEntry.metadata.maxInputTokens) {
				const inputDiv = DOM.append(templateData.tokenLimitsElement, $('.token-limit-item'));
				DOM.append(inputDiv, $('span.codicon.codicon-arrow-down'));
				const inputText = DOM.append(inputDiv, $('span'));
				inputText.textContent = formatTokenCount(modelEntry.metadata.maxInputTokens);

				markdown.appendMarkdown(`$(arrow-down) ${modelEntry.metadata.maxInputTokens} (${localize('models.input', 'Input')})`);
				addSeparator = true;
			}
			if (modelEntry.metadata.maxOutputTokens) {
				const outputDiv = DOM.append(templateData.tokenLimitsElement, $('.token-limit-item'));
				DOM.append(outputDiv, $('span.codicon.codicon-arrow-up'));
				const outputText = DOM.append(outputDiv, $('span'));
				outputText.textContent = formatTokenCount(modelEntry.metadata.maxOutputTokens);
				if (addSeparator) {
					markdown.appendText(`  |  `);
				}
				markdown.appendMarkdown(`$(arrow-up) ${modelEntry.metadata.maxOutputTokens} (${localize('models.output', 'Output')})`);
			}
		}

		templateData.elementDisposables.add(this.hoverService.setupDelayedHoverAtMouse(templateData.container, () => ({
			content: markdown,
			appearance: {
				compact: true,
				skipFadeInAnimation: true,
			}
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L1116-L1156)

```
				costColumnRenderer,
				tokenLimitsColumnRenderer,
				capabilitiesColumnRenderer,
				actionsColumnRenderer,
				providerColumnRenderer
			],
			{
				identityProvider: { getId: (e: IViewModelEntry) => e.id },
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel: (e: IViewModelEntry) => {
						if (isLanguageModelProviderEntry(e)) {
							return localize('vendor.ariaLabel', '{0} Models', e.vendorEntry.group.name);
						} else if (isLanguageModelGroupEntry(e)) {
							return e.id === 'visible' ? localize('visible.ariaLabel', 'Visible Models') : localize('hidden.ariaLabel', 'Hidden Models');
						} else if (isStatusEntry(e)) {
							return localize('status.ariaLabel', 'Status: {0}', e.message);
						}
						const ariaLabels = [];
						ariaLabels.push(localize('model.name', '{0} from {1}', e.model.metadata.name, e.model.provider.vendor.displayName));
						if (e.model.metadata.maxInputTokens && e.model.metadata.maxOutputTokens) {
							ariaLabels.push(localize('model.contextSize', 'Context size: {0} input tokens and {1} output tokens', formatTokenCount(e.model.metadata.maxInputTokens), formatTokenCount(e.model.metadata.maxOutputTokens)));
						}
						if (e.model.metadata.capabilities) {
							ariaLabels.push(localize('model.capabilities', 'Capabilities: {0}', Object.keys(e.model.metadata.capabilities).join(', ')));
						}
						const multiplierText = e.model.metadata.multiplier ?? '-';
						if (multiplierText !== '-') {
							ariaLabels.push(localize('multiplier.tooltip', "Every chat message counts {0} towards your premium model request quota", multiplierText));
						}
						if (e.model.visible) {
							ariaLabels.push(localize('model.visible', 'This model is visible in the chat model picker'));
						} else {
							ariaLabels.push(localize('model.hidden', 'This model is hidden in the chat model picker'));
						}
						return ariaLabels.join('. ');
					},
					getWidgetAriaLabel: () => localize('modelsTable.ariaLabel', 'Language Models')
				},
				multipleSelectionSupport: true,
				setRowLineHeight: false,
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts#L1117-L1157)

```
				tokenLimitsColumnRenderer,
				capabilitiesColumnRenderer,
				actionsColumnRenderer,
				providerColumnRenderer
			],
			{
				identityProvider: { getId: (e: IViewModelEntry) => e.id },
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel: (e: IViewModelEntry) => {
						if (isLanguageModelProviderEntry(e)) {
							return localize('vendor.ariaLabel', '{0} Models', e.vendorEntry.group.name);
						} else if (isLanguageModelGroupEntry(e)) {
							return e.id === 'visible' ? localize('visible.ariaLabel', 'Visible Models') : localize('hidden.ariaLabel', 'Hidden Models');
						} else if (isStatusEntry(e)) {
							return localize('status.ariaLabel', 'Status: {0}', e.message);
						}
						const ariaLabels = [];
						ariaLabels.push(localize('model.name', '{0} from {1}', e.model.metadata.name, e.model.provider.vendor.displayName));
						if (e.model.metadata.maxInputTokens && e.model.metadata.maxOutputTokens) {
							ariaLabels.push(localize('model.contextSize', 'Context size: {0} input tokens and {1} output tokens', formatTokenCount(e.model.metadata.maxInputTokens), formatTokenCount(e.model.metadata.maxOutputTokens)));
						}
						if (e.model.metadata.capabilities) {
							ariaLabels.push(localize('model.capabilities', 'Capabilities: {0}', Object.keys(e.model.metadata.capabilities).join(', ')));
						}
						const multiplierText = e.model.metadata.multiplier ?? '-';
						if (multiplierText !== '-') {
							ariaLabels.push(localize('multiplier.tooltip', "Every chat message counts {0} towards your premium model request quota", multiplierText));
						}
						if (e.model.visible) {
							ariaLabels.push(localize('model.visible', 'This model is visible in the chat model picker'));
						} else {
							ariaLabels.push(localize('model.hidden', 'This model is hidden in the chat model picker'));
						}
						return ariaLabels.join('. ');
					},
					getWidgetAriaLabel: () => localize('modelsTable.ariaLabel', 'Language Models')
				},
				multipleSelectionSupport: true,
				setRowLineHeight: false,
				openOnSingleClick: true,
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts#L5-L45)

```

import './media/chatContextUsageDetails.css';
import * as dom from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { IMenuService, MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { MenuWorkbenchButtonBar } from '../../../../../../platform/actions/browser/buttonbar.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';

const $ = dom.$;

export interface IChatContextUsagePromptTokenDetail {
	category: string;
	label: string;
	percentageOfPrompt: number;
}

export interface IChatContextUsageData {
	promptTokens: number;
	maxInputTokens: number;
	percentage: number;
	promptTokenDetails?: readonly IChatContextUsagePromptTokenDetail[];
}

/**
 * Detailed widget that shows context usage breakdown.
 * Displayed when the user clicks on the ChatContextUsageIcon.
 */
export class ChatContextUsageDetails extends Disposable {

	readonly domNode: HTMLElement;

	private readonly quotaItem: HTMLElement;
	private readonly percentageLabel: HTMLElement;
	private readonly tokenCountLabel: HTMLElement;
	private readonly progressFill: HTMLElement;
	private readonly tokenDetailsContainer: HTMLElement;
	private readonly warningMessage: HTMLElement;
	private readonly actionsSection: HTMLElement;

```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts#L86-L126)

```
		const buttonBarContainer = this.actionsSection.appendChild($('.button-bar-container'));
		this._register(this.instantiationService.createInstance(MenuWorkbenchButtonBar, buttonBarContainer, MenuId.ChatContextUsageActions, {
			toolbarOptions: {
				primaryGroup: () => true
			},
			buttonConfigProvider: () => ({ isSecondary: true })
		}));

		// Listen to menu changes to show/hide actions section
		const menu = this._register(this.menuService.createMenu(MenuId.ChatContextUsageActions, this.contextKeyService));
		const updateActionsVisibility = () => {
			const actions = menu.getActions();
			const hasActions = actions.length > 0 && actions.some(([, items]) => items.length > 0);
			this.actionsSection.style.display = hasActions ? '' : 'none';
		};
		this._register(menu.onDidChange(updateActionsVisibility));
		updateActionsVisibility();
	}

	update(data: IChatContextUsageData): void {
		const { percentage, promptTokens, maxInputTokens, promptTokenDetails } = data;

		// Update token count and percentage on same line
		this.tokenCountLabel.textContent = localize(
			'tokenCount',
			"{0} / {1} tokens",
			this.formatTokenCount(promptTokens, 1),
			this.formatTokenCount(maxInputTokens, 0)
		);
		this.percentageLabel.textContent = `• ${percentage.toFixed(0)}%`;

		// Update progress bar
		this.progressFill.style.width = `${Math.min(100, percentage)}%`;

		// Update color classes based on usage level on the quota item
		this.quotaItem.classList.remove('warning', 'error');
		if (percentage >= 90) {
			this.quotaItem.classList.add('error');
		} else if (percentage >= 75) {
			this.quotaItem.classList.add('warning');
		}
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts](.reference/vscode/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatContextUsageDetails.ts#L93-L133)

```

		// Listen to menu changes to show/hide actions section
		const menu = this._register(this.menuService.createMenu(MenuId.ChatContextUsageActions, this.contextKeyService));
		const updateActionsVisibility = () => {
			const actions = menu.getActions();
			const hasActions = actions.length > 0 && actions.some(([, items]) => items.length > 0);
			this.actionsSection.style.display = hasActions ? '' : 'none';
		};
		this._register(menu.onDidChange(updateActionsVisibility));
		updateActionsVisibility();
	}

	update(data: IChatContextUsageData): void {
		const { percentage, promptTokens, maxInputTokens, promptTokenDetails } = data;

		// Update token count and percentage on same line
		this.tokenCountLabel.textContent = localize(
			'tokenCount',
			"{0} / {1} tokens",
			this.formatTokenCount(promptTokens, 1),
			this.formatTokenCount(maxInputTokens, 0)
		);
		this.percentageLabel.textContent = `• ${percentage.toFixed(0)}%`;

		// Update progress bar
		this.progressFill.style.width = `${Math.min(100, percentage)}%`;

		// Update color classes based on usage level on the quota item
		this.quotaItem.classList.remove('warning', 'error');
		if (percentage >= 90) {
			this.quotaItem.classList.add('error');
		} else if (percentage >= 75) {
			this.quotaItem.classList.add('warning');
		}

		// Render token details breakdown if available
		this.renderTokenDetails(promptTokenDetails, percentage);

		// Show/hide warning message
		this.warningMessage.style.display = percentage >= 75 ? '' : 'none';
	}
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L52-L92)

```
			new TestSecretStorageService(),
		);

		languageModels.deltaLanguageModelChatProviderDescriptors([
			{ vendor: 'test-vendor', displayName: 'Test Vendor', configuration: undefined, managementCommand: undefined, when: undefined },
			{ vendor: 'actual-vendor', displayName: 'Actual Vendor', configuration: undefined, managementCommand: undefined, when: undefined }
		], []);

		store.add(languageModels.registerLanguageModelProvider('test-vendor', {
			onDidChange: Event.None,
			provideLanguageModelChatInfo: async () => {
				const modelMetadata = [
					{
						extension: nullExtensionDescription.identifier,
						name: 'Pretty Name',
						vendor: 'test-vendor',
						family: 'test-family',
						version: 'test-version',
						modelPickerCategory: undefined,
						id: 'test-id-1',
						maxInputTokens: 100,
						maxOutputTokens: 100,
						isDefaultForLocation: {}
					} satisfies ILanguageModelChatMetadata,
					{
						extension: nullExtensionDescription.identifier,
						name: 'Pretty Name',
						vendor: 'test-vendor',
						family: 'test2-family',
						version: 'test2-version',
						modelPickerCategory: undefined,
						id: 'test-id-12',
						maxInputTokens: 100,
						maxOutputTokens: 100,
						isDefaultForLocation: {}
					} satisfies ILanguageModelChatMetadata
				];
				const modelMetadataAndIdentifier = modelMetadata.map(m => ({
					metadata: m,
					identifier: m.id,
				}));
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L64-L104)

```
					{
						extension: nullExtensionDescription.identifier,
						name: 'Pretty Name',
						vendor: 'test-vendor',
						family: 'test-family',
						version: 'test-version',
						modelPickerCategory: undefined,
						id: 'test-id-1',
						maxInputTokens: 100,
						maxOutputTokens: 100,
						isDefaultForLocation: {}
					} satisfies ILanguageModelChatMetadata,
					{
						extension: nullExtensionDescription.identifier,
						name: 'Pretty Name',
						vendor: 'test-vendor',
						family: 'test2-family',
						version: 'test2-version',
						modelPickerCategory: undefined,
						id: 'test-id-12',
						maxInputTokens: 100,
						maxOutputTokens: 100,
						isDefaultForLocation: {}
					} satisfies ILanguageModelChatMetadata
				];
				const modelMetadataAndIdentifier = modelMetadata.map(m => ({
					metadata: m,
					identifier: m.id,
				}));
				return modelMetadataAndIdentifier;
			},
			sendChatRequest: async () => {
				throw new Error();
			},
			provideTokenCount: async () => {
				throw new Error();
			}
		}));
	});

	teardown(function () {
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L127-L167)

```
		const result1 = await languageModels.selectLanguageModels({ vendor: 'test-vendor' });
		assert.deepStrictEqual(result1.length, 2);

		const result2 = await languageModels.selectLanguageModels({ vendor: 'test-vendor', family: 'FAKE' });
		assert.deepStrictEqual(result2.length, 0);
	});

	test('sendChatRequest returns a response-stream', async function () {

		store.add(languageModels.registerLanguageModelProvider('actual-vendor', {
			onDidChange: Event.None,
			provideLanguageModelChatInfo: async () => {
				const modelMetadata = [
					{
						extension: nullExtensionDescription.identifier,
						name: 'Pretty Name',
						vendor: 'actual-vendor',
						family: 'actual-family',
						version: 'actual-version',
						id: 'actual-lm',
						maxInputTokens: 100,
						maxOutputTokens: 100,
						modelPickerCategory: DEFAULT_MODEL_PICKER_CATEGORY,
						isDefaultForLocation: {}
					} satisfies ILanguageModelChatMetadata
				];
				const modelMetadataAndIdentifier = modelMetadata.map(m => ({
					metadata: m,
					identifier: m.id,
				}));
				return modelMetadataAndIdentifier;
			},
			sendChatRequest: async (modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier, _options: { [name: string]: any }, token: CancellationToken) => {
				// const message = messages.at(-1);

				const defer = new DeferredPromise();
				const stream = new AsyncIterableSource<IChatResponsePart>();

				(async () => {
					while (!token.isCancellationRequested) {
						stream.emitOne({ type: 'text', value: Date.now().toString() });
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L313-L353)

```
			new class extends mock<IQuickInputService>() { },
			new TestSecretStorageService(),
		);

		// Register vendor1 used in most tests
		languageModelsService.deltaLanguageModelChatProviderDescriptors([
			{ vendor: 'vendor1', displayName: 'Vendor 1', configuration: undefined, managementCommand: undefined, when: undefined }
		], []);

		disposables.add(languageModelsService.registerLanguageModelProvider('vendor1', {
			onDidChange: Event.None,
			provideLanguageModelChatInfo: async () => {
				return [{
					metadata: {
						extension: nullExtensionDescription.identifier,
						name: 'Model 1',
						vendor: 'vendor1',
						family: 'family1',
						version: '1.0',
						id: 'vendor1/model1',
						maxInputTokens: 100,
						maxOutputTokens: 100,
						modelPickerCategory: DEFAULT_MODEL_PICKER_CATEGORY,
						isDefaultForLocation: {}
					} satisfies ILanguageModelChatMetadata,
					identifier: 'vendor1/model1'
				}];
			},
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		// Populate the model cache
		await languageModelsService.selectLanguageModels({});
	});

	teardown(function () {
		languageModelsService.dispose();
		disposables.clear();
	});

```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L421-L461)

```
		assert.strictEqual(model.isUserSelectable, false);
	});

	test('only fires onChange event for affected vendors', async function () {
		// Register vendor2
		languageModelsService.deltaLanguageModelChatProviderDescriptors([
			{ vendor: 'vendor2', displayName: 'Vendor 2', configuration: undefined, managementCommand: undefined, when: undefined }
		], []);

		disposables.add(languageModelsService.registerLanguageModelProvider('vendor2', {
			onDidChange: Event.None,
			provideLanguageModelChatInfo: async () => {
				return [{
					metadata: {
						extension: nullExtensionDescription.identifier,
						name: 'Model 2',
						vendor: 'vendor2',
						family: 'family2',
						version: '1.0',
						id: 'vendor2/model2',
						maxInputTokens: 100,
						maxOutputTokens: 100,
						modelPickerCategory: DEFAULT_MODEL_PICKER_CATEGORY,
						isDefaultForLocation: {}
					} satisfies ILanguageModelChatMetadata,
					identifier: 'vendor2/model2'
				}];
			},
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		await languageModelsService.selectLanguageModels({});

		// Set initial preferences using the API
		languageModelsService.updateModelPickerPreference('vendor1/model1', true);
		languageModelsService.updateModelPickerPreference('vendor2/model2', false);

		// Listen for change event
		let firedVendorId: string | undefined;
		disposables.add(languageModelsService.onDidChangeLanguageModels(vendorId => {
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L568-L608)

```
		const eventPromise = new Promise<string>((resolve) => {
			disposables.add(languageModelsService.onDidChangeLanguageModels((vendorId) => {
				resolve(vendorId);
			}));
		});

		// Store a preference to trigger auto-resolution when provider is registered
		storageService.store('chatModelPickerPreferences', JSON.stringify({ 'test-vendor/model1': true }), StorageScope.PROFILE, StorageTarget.USER);

		disposables.add(languageModelsService.registerLanguageModelProvider('test-vendor', {
			onDidChange: Event.None,
			provideLanguageModelChatInfo: async () => {
				return [{
					metadata: {
						extension: nullExtensionDescription.identifier,
						name: 'Model 1',
						vendor: 'test-vendor',
						family: 'family1',
						version: '1.0',
						id: 'model1',
						maxInputTokens: 100,
						maxOutputTokens: 100,
						modelPickerCategory: undefined,
						isDefaultForLocation: {}
					} satisfies ILanguageModelChatMetadata,
					identifier: 'test-vendor/model1'
				}];
			},
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		const firedVendorId = await eventPromise;
		assert.strictEqual(firedVendorId, 'test-vendor', 'Should fire event when new models are added');
	});

	test('does not fire onChange event when models are unchanged', async function () {
		const models = [{
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: 'Model 1',
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L593-L633)

```
					identifier: 'test-vendor/model1'
				}];
			},
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		const firedVendorId = await eventPromise;
		assert.strictEqual(firedVendorId, 'test-vendor', 'Should fire event when new models are added');
	});

	test('does not fire onChange event when models are unchanged', async function () {
		const models = [{
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: 'Model 1',
				vendor: 'test-vendor',
				family: 'family1',
				version: '1.0',
				id: 'model1',
				maxInputTokens: 100,
				maxOutputTokens: 100,
				modelPickerCategory: undefined,
				isDefaultForLocation: {}
			} satisfies ILanguageModelChatMetadata,
			identifier: 'test-vendor/model1'
		}];

		let onDidChangeEmitter: any;
		disposables.add(languageModelsService.registerLanguageModelProvider('test-vendor', {
			onDidChange: (listener) => {
				onDidChangeEmitter = { fire: () => listener() };
				return { dispose: () => { } };
			},
			provideLanguageModelChatInfo: async () => models,
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		// Initial resolution
		await languageModelsService.selectLanguageModels({ vendor: 'test-vendor' });
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L637-L677)

```
		disposables.add(languageModelsService.onDidChangeLanguageModels(() => {
			eventFired = true;
		}));
		// Trigger provider change with same models
		onDidChangeEmitter.fire();

		// Call selectLanguageModels again - provider will return different models
		await languageModelsService.selectLanguageModels({ vendor: 'test-vendor' });
		assert.strictEqual(eventFired, false, 'Should not fire event when models are unchanged');
	});

	test('fires onChange event when model metadata changes', async function () {
		const initialModels = [{
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: 'Model 1',
				vendor: 'test-vendor',
				family: 'family1',
				version: '1.0',
				id: 'model1',
				maxInputTokens: 100,
				maxOutputTokens: 100,
				modelPickerCategory: undefined,
				isDefaultForLocation: {}
			} satisfies ILanguageModelChatMetadata,
			identifier: 'test-vendor/model1'
		}];

		let currentModels = initialModels;
		let onDidChangeEmitter: any;
		disposables.add(languageModelsService.registerLanguageModelProvider('test-vendor', {
			onDidChange: (listener) => {
				onDidChangeEmitter = { fire: () => listener() };
				return { dispose: () => { } };
			},
			provideLanguageModelChatInfo: async () => currentModels,
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		// Initial resolution
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L667-L707)

```
		disposables.add(languageModelsService.registerLanguageModelProvider('test-vendor', {
			onDidChange: (listener) => {
				onDidChangeEmitter = { fire: () => listener() };
				return { dispose: () => { } };
			},
			provideLanguageModelChatInfo: async () => currentModels,
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		// Initial resolution
		await languageModelsService.selectLanguageModels({ vendor: 'test-vendor' });

		// Create a promise that resolves when the event fires
		const eventPromise = new Promise<void>((resolve) => {
			disposables.add(languageModelsService.onDidChangeLanguageModels(() => {
				resolve();
			}));
		});

		// Change model metadata (e.g., maxInputTokens)
		currentModels = [{
			metadata: {
				...initialModels[0].metadata,
				maxInputTokens: 200 // Changed from 100
			},
			identifier: 'test-vendor/model1'
		}];

		onDidChangeEmitter.fire();

		await eventPromise;
		assert.ok(true, 'Event fired when model metadata changed');
	});

	test('fires onChange event when models are removed', async function () {
		let currentModels = [{
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: 'Model 1',
				vendor: 'test-vendor',
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L671-L711)

```
			},
			provideLanguageModelChatInfo: async () => currentModels,
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		// Initial resolution
		await languageModelsService.selectLanguageModels({ vendor: 'test-vendor' });

		// Create a promise that resolves when the event fires
		const eventPromise = new Promise<void>((resolve) => {
			disposables.add(languageModelsService.onDidChangeLanguageModels(() => {
				resolve();
			}));
		});

		// Change model metadata (e.g., maxInputTokens)
		currentModels = [{
			metadata: {
				...initialModels[0].metadata,
				maxInputTokens: 200 // Changed from 100
			},
			identifier: 'test-vendor/model1'
		}];

		onDidChangeEmitter.fire();

		await eventPromise;
		assert.ok(true, 'Event fired when model metadata changed');
	});

	test('fires onChange event when models are removed', async function () {
		let currentModels = [{
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: 'Model 1',
				vendor: 'test-vendor',
				family: 'family1',
				version: '1.0',
				id: 'model1',
				maxInputTokens: 100,
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L691-L731)

```
				maxInputTokens: 200 // Changed from 100
			},
			identifier: 'test-vendor/model1'
		}];

		onDidChangeEmitter.fire();

		await eventPromise;
		assert.ok(true, 'Event fired when model metadata changed');
	});

	test('fires onChange event when models are removed', async function () {
		let currentModels = [{
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: 'Model 1',
				vendor: 'test-vendor',
				family: 'family1',
				version: '1.0',
				id: 'model1',
				maxInputTokens: 100,
				maxOutputTokens: 100,
				modelPickerCategory: undefined,
				isDefaultForLocation: {}
			} satisfies ILanguageModelChatMetadata,
			identifier: 'test-vendor/model1'
		}];

		let onDidChangeEmitter: any;
		disposables.add(languageModelsService.registerLanguageModelProvider('test-vendor', {
			onDidChange: (listener) => {
				onDidChangeEmitter = { fire: () => listener() };
				return { dispose: () => { } };
			},
			provideLanguageModelChatInfo: async () => currentModels,
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		// Initial resolution
		await languageModelsService.selectLanguageModels({ vendor: 'test-vendor' });
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L738-L778)

```
		});

		// Remove all models
		currentModels = [];

		onDidChangeEmitter.fire();

		await eventPromise;
		assert.ok(true, 'Event fired when models were removed');
	});

	test('fires onChange event when new model is added to existing set', async function () {
		let currentModels = [{
			metadata: {
				extension: nullExtensionDescription.identifier,
				name: 'Model 1',
				vendor: 'test-vendor',
				family: 'family1',
				version: '1.0',
				id: 'model1',
				maxInputTokens: 100,
				maxOutputTokens: 100,
				modelPickerCategory: undefined,
				isDefaultForLocation: {}
			} satisfies ILanguageModelChatMetadata,
			identifier: 'test-vendor/model1'
		}];

		let onDidChangeEmitter: any;
		disposables.add(languageModelsService.registerLanguageModelProvider('test-vendor', {
			onDidChange: (listener) => {
				onDidChangeEmitter = { fire: () => listener() };
				return { dispose: () => { } };
			},
			provideLanguageModelChatInfo: async () => currentModels,
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		// Initial resolution
		await languageModelsService.selectLanguageModels({ vendor: 'test-vendor' });
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L778-L818)

```
		await languageModelsService.selectLanguageModels({ vendor: 'test-vendor' });

		// Create a promise that resolves when the event fires
		const eventPromise = new Promise<void>((resolve) => {
			disposables.add(languageModelsService.onDidChangeLanguageModels(() => {
				resolve();
			}));
		});

		// Add a new model
		currentModels = [
			...currentModels,
			{
				metadata: {
					extension: nullExtensionDescription.identifier,
					name: 'Model 2',
					vendor: 'test-vendor',
					family: 'family2',
					version: '1.0',
					id: 'model2',
					maxInputTokens: 100,
					maxOutputTokens: 100,
					modelPickerCategory: undefined,
					isDefaultForLocation: {}
				} satisfies ILanguageModelChatMetadata,
				identifier: 'test-vendor/model2'
			}
		];

		onDidChangeEmitter.fire();

		await eventPromise;
		assert.ok(true, 'Event fired when new model was added');
	});

	test('fires onChange event when models change without provider emitting change event', async function () {
		let callCount = 0;
		disposables.add(languageModelsService.registerLanguageModelProvider('test-vendor', {
			onDidChange: Event.None, // Provider doesn't emit change events
			provideLanguageModelChatInfo: async () => {
				callCount++;
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L809-L849)

```
		await eventPromise;
		assert.ok(true, 'Event fired when new model was added');
	});

	test('fires onChange event when models change without provider emitting change event', async function () {
		let callCount = 0;
		disposables.add(languageModelsService.registerLanguageModelProvider('test-vendor', {
			onDidChange: Event.None, // Provider doesn't emit change events
			provideLanguageModelChatInfo: async () => {
				callCount++;
				if (callCount === 1) {
					// First call returns initial model
					return [{
						metadata: {
							extension: nullExtensionDescription.identifier,
							name: 'Model 1',
							vendor: 'test-vendor',
							family: 'family1',
							version: '1.0',
							id: 'model1',
							maxInputTokens: 100,
							maxOutputTokens: 100,
							modelPickerCategory: undefined,
							isDefaultForLocation: {}
						} satisfies ILanguageModelChatMetadata,
						identifier: 'test-vendor/model1'
					}];
				} else {
					// Subsequent calls return different model
					return [{
						metadata: {
							extension: nullExtensionDescription.identifier,
							name: 'Model 2',
							vendor: 'test-vendor',
							family: 'family2',
							version: '2.0',
							id: 'model2',
							maxInputTokens: 200,
							maxOutputTokens: 200,
							modelPickerCategory: undefined,
							isDefaultForLocation: {}
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/common/languageModels.test.ts#L826-L866)

```
							family: 'family1',
							version: '1.0',
							id: 'model1',
							maxInputTokens: 100,
							maxOutputTokens: 100,
							modelPickerCategory: undefined,
							isDefaultForLocation: {}
						} satisfies ILanguageModelChatMetadata,
						identifier: 'test-vendor/model1'
					}];
				} else {
					// Subsequent calls return different model
					return [{
						metadata: {
							extension: nullExtensionDescription.identifier,
							name: 'Model 2',
							vendor: 'test-vendor',
							family: 'family2',
							version: '2.0',
							id: 'model2',
							maxInputTokens: 200,
							maxOutputTokens: 200,
							modelPickerCategory: undefined,
							isDefaultForLocation: {}
						} satisfies ILanguageModelChatMetadata,
						identifier: 'test-vendor/model2'
					}];
				}
			},
			sendChatRequest: async () => { throw new Error(); },
			provideTokenCount: async () => { throw new Error(); }
		}));

		// Initial resolution
		await languageModelsService.selectLanguageModels({ vendor: 'test-vendor' });

		// Listen for change event
		let eventFired = false;
		disposables.add(languageModelsService.onDidChangeLanguageModels(() => {
			eventFired = true;
		}));
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L151-L191)

```
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		languageModelsService.addVendor({
			vendor: 'openai',
			displayName: 'OpenAI',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		languageModelsService.addModel('copilot', 'copilot-gpt-4', {
			extension: new ExtensionIdentifier('github.copilot'),
			id: 'gpt-4',
			name: 'GPT-4',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'copilot',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			modelPickerCategory: { label: 'Copilot', order: 1 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: true,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addModel('copilot', 'copilot-gpt-4o', {
			extension: new ExtensionIdentifier('github.copilot'),
			id: 'gpt-4o',
			name: 'GPT-4o',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'copilot',
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L172-L212)

```
			maxOutputTokens: 4096,
			modelPickerCategory: { label: 'Copilot', order: 1 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: true,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addModel('copilot', 'copilot-gpt-4o', {
			extension: new ExtensionIdentifier('github.copilot'),
			id: 'gpt-4o',
			name: 'GPT-4o',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'copilot',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			modelPickerCategory: { label: 'Copilot', order: 1 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: true,
				agentMode: true
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addModel('openai', 'openai-gpt-3.5', {
			extension: new ExtensionIdentifier('openai.api'),
			id: 'gpt-3.5-turbo',
			name: 'GPT-3.5 Turbo',
			family: 'gpt-3.5',
			version: '1.0',
			vendor: 'openai',
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L193-L233)

```
			maxOutputTokens: 4096,
			modelPickerCategory: { label: 'Copilot', order: 1 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: true,
				agentMode: true
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addModel('openai', 'openai-gpt-3.5', {
			extension: new ExtensionIdentifier('openai.api'),
			id: 'gpt-3.5-turbo',
			name: 'GPT-3.5 Turbo',
			family: 'gpt-3.5',
			version: '1.0',
			vendor: 'openai',
			maxInputTokens: 4096,
			maxOutputTokens: 2048,
			modelPickerCategory: { label: 'OpenAI', order: 2 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: false,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addModel('openai', 'openai-gpt-4-vision', {
			extension: new ExtensionIdentifier('openai.api'),
			id: 'gpt-4-vision',
			name: 'GPT-4 Vision',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'openai',
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L214-L254)

```
			maxOutputTokens: 2048,
			modelPickerCategory: { label: 'OpenAI', order: 2 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: false,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addModel('openai', 'openai-gpt-4-vision', {
			extension: new ExtensionIdentifier('openai.api'),
			id: 'gpt-4-vision',
			name: 'GPT-4 Vision',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'openai',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			modelPickerCategory: { label: 'OpenAI', order: 2 },
			isUserSelectable: false,
			capabilities: {
				toolCalling: false,
				vision: true,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		viewModel = store.add(new ChatModelsViewModel(languageModelsService));

		await viewModel.refresh();
	});

	test('should fetch all models without filters', () => {
		const results = viewModel.filter('');
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L531-L571)

```
		}
	});

	function createSingleVendorViewModel(includeSecondModel: boolean = true): { service: MockLanguageModelsService; viewModel: ChatModelsViewModel } {
		const service = new MockLanguageModelsService();
		service.addVendor({
			vendor: 'copilot',
			displayName: 'GitHub Copilot',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		service.addModel('copilot', 'copilot-gpt-4', {
			extension: new ExtensionIdentifier('github.copilot'),
			id: 'gpt-4',
			name: 'GPT-4',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'copilot',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			modelPickerCategory: { label: 'Copilot', order: 1 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: true,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		if (includeSecondModel) {
			service.addModel('copilot', 'copilot-gpt-4o', {
				extension: new ExtensionIdentifier('github.copilot'),
				id: 'gpt-4o',
				name: 'GPT-4o',
				family: 'gpt-4',
				version: '1.0',
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L553-L593)

```
			modelPickerCategory: { label: 'Copilot', order: 1 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: true,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		if (includeSecondModel) {
			service.addModel('copilot', 'copilot-gpt-4o', {
				extension: new ExtensionIdentifier('github.copilot'),
				id: 'gpt-4o',
				name: 'GPT-4o',
				family: 'gpt-4',
				version: '1.0',
				vendor: 'copilot',
				maxInputTokens: 8192,
				maxOutputTokens: 4096,
				modelPickerCategory: { label: 'Copilot', order: 1 },
				isUserSelectable: true,
				capabilities: {
					toolCalling: true,
					vision: true,
					agentMode: true
				},
				isDefaultForLocation: {
					[ChatAgentLocation.Chat]: true
				}
			});
		}

		const viewModel = store.add(new ChatModelsViewModel(service));
		return { service, viewModel };
	}

	test('should not show vendor header when only one vendor exists', async () => {
		const { viewModel: singleVendorViewModel } = createSingleVendorViewModel();
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L637-L677)

```
		let results = viewModel.filter('');
		let vendors = results.filter(isLanguageModelProviderEntry) as ILanguageModelProviderEntry[];
		assert.strictEqual(vendors[0].vendorEntry.vendor.vendor, 'copilot');

		// Add more vendors to ensure sorting works correctly
		languageModelsService.addVendor({
			vendor: 'anthropic',
			displayName: 'Anthropic',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		languageModelsService.addModel('anthropic', 'anthropic-claude', {
			extension: new ExtensionIdentifier('anthropic.api'),
			id: 'claude-3',
			name: 'Claude 3',
			family: 'claude',
			version: '1.0',
			vendor: 'anthropic',
			maxInputTokens: 100000,
			maxOutputTokens: 4096,
			modelPickerCategory: { label: 'Anthropic', order: 3 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: false,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addVendor({
			vendor: 'azure',
			displayName: 'Azure OpenAI',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L666-L706)

```
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		languageModelsService.addVendor({
			vendor: 'azure',
			displayName: 'Azure OpenAI',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		languageModelsService.addModel('azure', 'azure-gpt-4', {
			extension: new ExtensionIdentifier('microsoft.azure'),
			id: 'azure-gpt-4',
			name: 'Azure GPT-4',
			family: 'gpt-4',
			version: '1.0',
			vendor: 'azure',
			maxInputTokens: 8192,
			maxOutputTokens: 4096,
			modelPickerCategory: { label: 'Azure', order: 4 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: false,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		await viewModel.refresh();

		// Test with all filters and searches
		results = viewModel.filter('');
		vendors = results.filter(isLanguageModelProviderEntry) as ILanguageModelProviderEntry[];
		assert.strictEqual(vendors.length, 4);
		assert.strictEqual(vendors[0].vendorEntry.vendor.vendor, 'copilot');
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/chatManagement/chatModelsViewModel.test.ts#L778-L818)

```
		const groups = results.filter(isLanguageModelGroupEntry) as ILanguageModelGroupEntry[];
		assert.ok(groups.every(v => !v.collapsed));
	});

	test('should sort models within visibility groups', async () => {
		languageModelsService.addVendor({
			vendor: 'anthropic',
			displayName: 'Anthropic',
			managementCommand: undefined,
			when: undefined,
			configuration: undefined
		});

		languageModelsService.addModel('anthropic', 'anthropic-claude', {
			extension: new ExtensionIdentifier('anthropic.api'),
			id: 'claude-3',
			name: 'Claude 3',
			family: 'claude',
			version: '1.0',
			vendor: 'anthropic',
			maxInputTokens: 100000,
			maxOutputTokens: 4096,
			modelPickerCategory: { label: 'Anthropic', order: 3 },
			isUserSelectable: true,
			capabilities: {
				toolCalling: true,
				vision: false,
				agentMode: false
			},
			isDefaultForLocation: {
				[ChatAgentLocation.Chat]: true
			}
		});

		await viewModel.refresh();

		viewModel.groupBy = ChatModelGroup.Visibility;
		const actuals = viewModel.viewModelEntries;

		assert.strictEqual(actuals.length, 7);

```

#### [.reference/vscode/src/vs/workbench/contrib/chat/common/languageModels.ts](.reference/vscode/src/vs/workbench/contrib/chat/common/languageModels.ts#L160-L200)

```
	description: string;
	author: string;
	linkTag: string;
}

export type IChatResponsePart = IChatResponseTextPart | IChatResponseToolUsePart | IChatResponseDataPart | IChatResponseThinkingPart;

export type IExtendedChatResponsePart = IChatResponsePullRequestPart;

export interface ILanguageModelChatMetadata {
	readonly extension: ExtensionIdentifier;

	readonly name: string;
	readonly id: string;
	readonly vendor: string;
	readonly version: string;
	readonly tooltip?: string;
	readonly detail?: string;
	readonly multiplier?: string;
	readonly family: string;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;

	readonly isDefaultForLocation: { [K in ChatAgentLocation]?: boolean };
	readonly isUserSelectable?: boolean;
	readonly statusIcon?: ThemeIcon;
	readonly modelPickerCategory: { label: string; order: number } | undefined;
	readonly auth?: {
		readonly providerLabel: string;
		readonly accountLabel?: string;
	};
	readonly capabilities?: {
		readonly vision?: boolean;
		readonly toolCalling?: boolean;
		readonly agentMode?: boolean;
		readonly editTools?: ReadonlyArray<string>;
	};
}

export namespace ILanguageModelChatMetadata {
	export function suitableForAgentMode(metadata: ILanguageModelChatMetadata): boolean {
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts#L96-L136)

```
			'conflictSet1Ref',
			{ legacyFullNames: ['sharedLegacyName'] }
		));
		const conflictTool1 = { id: 'conflictTool1', toolReferenceName: 'conflictTool1Ref', displayName: 'Conflict Tool 1', canBeReferencedInPrompt: false, modelDescription: 'Conflict Tool 1', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(conflictTool1));
		disposables.add(conflictToolSet1.addTool(conflictTool1));

		const conflictToolSet2 = disposables.add(toolService.createToolSet(
			ToolDataSource.External,
			'conflictSet2',
			'conflictSet2Ref',
			{ legacyFullNames: ['sharedLegacyName'] }
		));
		const conflictTool2 = { id: 'conflictTool2', toolReferenceName: 'conflictTool2Ref', displayName: 'Conflict Tool 2', canBeReferencedInPrompt: false, modelDescription: 'Conflict Tool 2', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(conflictTool2));
		disposables.add(conflictToolSet2.addTool(conflictTool2));

		instaService.set(ILanguageModelToolsService, toolService);

		const testModels: ILanguageModelChatMetadata[] = [
			{ id: 'mae-4', name: 'MAE 4', vendor: 'olama', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-4.1', name: 'MAE 4.1', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-3.5-turbo', name: 'MAE 3.5 Turbo', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata
		];

		instaService.stub(ILanguageModelsService, {
			getLanguageModelIds() { return testModels.map(m => m.id); },
			lookupLanguageModelByQualifiedName(qualifiedName: string) {
				for (const metadata of testModels) {
					if (ILanguageModelChatMetadata.matchesQualifiedName(qualifiedName, metadata)) {
						return metadata;
					}
				}
				return undefined;
			}
		});

		const customChatMode = new CustomChatMode({
			uri: URI.parse('myFs://test/test/chatmode.md'),
			name: 'BeastMode',
			agentInstructions: { content: 'Beast mode instructions', toolReferences: [] },
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts#L97-L137)

```
			{ legacyFullNames: ['sharedLegacyName'] }
		));
		const conflictTool1 = { id: 'conflictTool1', toolReferenceName: 'conflictTool1Ref', displayName: 'Conflict Tool 1', canBeReferencedInPrompt: false, modelDescription: 'Conflict Tool 1', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(conflictTool1));
		disposables.add(conflictToolSet1.addTool(conflictTool1));

		const conflictToolSet2 = disposables.add(toolService.createToolSet(
			ToolDataSource.External,
			'conflictSet2',
			'conflictSet2Ref',
			{ legacyFullNames: ['sharedLegacyName'] }
		));
		const conflictTool2 = { id: 'conflictTool2', toolReferenceName: 'conflictTool2Ref', displayName: 'Conflict Tool 2', canBeReferencedInPrompt: false, modelDescription: 'Conflict Tool 2', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(conflictTool2));
		disposables.add(conflictToolSet2.addTool(conflictTool2));

		instaService.set(ILanguageModelToolsService, toolService);

		const testModels: ILanguageModelChatMetadata[] = [
			{ id: 'mae-4', name: 'MAE 4', vendor: 'olama', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-4.1', name: 'MAE 4.1', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-3.5-turbo', name: 'MAE 3.5 Turbo', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata
		];

		instaService.stub(ILanguageModelsService, {
			getLanguageModelIds() { return testModels.map(m => m.id); },
			lookupLanguageModelByQualifiedName(qualifiedName: string) {
				for (const metadata of testModels) {
					if (ILanguageModelChatMetadata.matchesQualifiedName(qualifiedName, metadata)) {
						return metadata;
					}
				}
				return undefined;
			}
		});

		const customChatMode = new CustomChatMode({
			uri: URI.parse('myFs://test/test/chatmode.md'),
			name: 'BeastMode',
			agentInstructions: { content: 'Beast mode instructions', toolReferences: [] },
			source: { storage: PromptsStorage.local },
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptValidator.test.ts#L98-L138)

```
		));
		const conflictTool1 = { id: 'conflictTool1', toolReferenceName: 'conflictTool1Ref', displayName: 'Conflict Tool 1', canBeReferencedInPrompt: false, modelDescription: 'Conflict Tool 1', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(conflictTool1));
		disposables.add(conflictToolSet1.addTool(conflictTool1));

		const conflictToolSet2 = disposables.add(toolService.createToolSet(
			ToolDataSource.External,
			'conflictSet2',
			'conflictSet2Ref',
			{ legacyFullNames: ['sharedLegacyName'] }
		));
		const conflictTool2 = { id: 'conflictTool2', toolReferenceName: 'conflictTool2Ref', displayName: 'Conflict Tool 2', canBeReferencedInPrompt: false, modelDescription: 'Conflict Tool 2', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(conflictTool2));
		disposables.add(conflictToolSet2.addTool(conflictTool2));

		instaService.set(ILanguageModelToolsService, toolService);

		const testModels: ILanguageModelChatMetadata[] = [
			{ id: 'mae-4', name: 'MAE 4', vendor: 'olama', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-4.1', name: 'MAE 4.1', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-3.5-turbo', name: 'MAE 3.5 Turbo', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata
		];

		instaService.stub(ILanguageModelsService, {
			getLanguageModelIds() { return testModels.map(m => m.id); },
			lookupLanguageModelByQualifiedName(qualifiedName: string) {
				for (const metadata of testModels) {
					if (ILanguageModelChatMetadata.matchesQualifiedName(qualifiedName, metadata)) {
						return metadata;
					}
				}
				return undefined;
			}
		});

		const customChatMode = new CustomChatMode({
			uri: URI.parse('myFs://test/test/chatmode.md'),
			name: 'BeastMode',
			agentInstructions: { content: 'Beast mode instructions', toolReferences: [] },
			source: { storage: PromptsStorage.local },
			visibility: { userInvokable: true, agentInvokable: true }
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts#L36-L76)

```

	setup(async () => {
		const testConfigService = new TestConfigurationService();
		testConfigService.setUserConfiguration(ChatConfiguration.ExtensionToolsEnabled, true);
		instaService = workbenchInstantiationService({
			contextKeyService: () => disposables.add(new ContextKeyService(testConfigService)),
			configurationService: () => testConfigService
		}, disposables);

		const toolService = disposables.add(instaService.createInstance(LanguageModelToolsService));

		const testTool1 = { id: 'testTool1', displayName: 'tool1', canBeReferencedInPrompt: true, modelDescription: 'Test Tool 1', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool1));

		const testTool2 = { id: 'testTool2', displayName: 'tool2', canBeReferencedInPrompt: true, toolReferenceName: 'tool2', modelDescription: 'Test Tool 2', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool2));

		instaService.set(ILanguageModelToolsService, toolService);

		const testModels: ILanguageModelChatMetadata[] = [
			{ id: 'mae-4', name: 'MAE 4', vendor: 'olama', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-4.1', name: 'MAE 4.1', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'gpt-4', name: 'GPT 4', vendor: 'openai', version: '1.0', family: 'gpt', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: false, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
		];

		instaService.stub(ILanguageModelsService, {
			getLanguageModelIds() { return testModels.map(m => m.id); },
			lookupLanguageModel(name: string) {
				return testModels.find(m => m.id === name);
			}
		});

		const customAgent: ICustomAgent = {
			name: 'agent1',
			description: 'Agent file 1.',
			agentInstructions: {
				content: '',
				toolReferences: [],
				metadata: undefined
			},
			uri: URI.parse('myFs://.github/agents/agent1.agent.md'),
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts#L37-L77)

```
	setup(async () => {
		const testConfigService = new TestConfigurationService();
		testConfigService.setUserConfiguration(ChatConfiguration.ExtensionToolsEnabled, true);
		instaService = workbenchInstantiationService({
			contextKeyService: () => disposables.add(new ContextKeyService(testConfigService)),
			configurationService: () => testConfigService
		}, disposables);

		const toolService = disposables.add(instaService.createInstance(LanguageModelToolsService));

		const testTool1 = { id: 'testTool1', displayName: 'tool1', canBeReferencedInPrompt: true, modelDescription: 'Test Tool 1', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool1));

		const testTool2 = { id: 'testTool2', displayName: 'tool2', canBeReferencedInPrompt: true, toolReferenceName: 'tool2', modelDescription: 'Test Tool 2', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool2));

		instaService.set(ILanguageModelToolsService, toolService);

		const testModels: ILanguageModelChatMetadata[] = [
			{ id: 'mae-4', name: 'MAE 4', vendor: 'olama', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-4.1', name: 'MAE 4.1', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'gpt-4', name: 'GPT 4', vendor: 'openai', version: '1.0', family: 'gpt', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: false, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
		];

		instaService.stub(ILanguageModelsService, {
			getLanguageModelIds() { return testModels.map(m => m.id); },
			lookupLanguageModel(name: string) {
				return testModels.find(m => m.id === name);
			}
		});

		const customAgent: ICustomAgent = {
			name: 'agent1',
			description: 'Agent file 1.',
			agentInstructions: {
				content: '',
				toolReferences: [],
				metadata: undefined
			},
			uri: URI.parse('myFs://.github/agents/agent1.agent.md'),
			source: { storage: PromptsStorage.local },
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHeaderAutocompletion.test.ts#L38-L78)

```
		const testConfigService = new TestConfigurationService();
		testConfigService.setUserConfiguration(ChatConfiguration.ExtensionToolsEnabled, true);
		instaService = workbenchInstantiationService({
			contextKeyService: () => disposables.add(new ContextKeyService(testConfigService)),
			configurationService: () => testConfigService
		}, disposables);

		const toolService = disposables.add(instaService.createInstance(LanguageModelToolsService));

		const testTool1 = { id: 'testTool1', displayName: 'tool1', canBeReferencedInPrompt: true, modelDescription: 'Test Tool 1', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool1));

		const testTool2 = { id: 'testTool2', displayName: 'tool2', canBeReferencedInPrompt: true, toolReferenceName: 'tool2', modelDescription: 'Test Tool 2', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool2));

		instaService.set(ILanguageModelToolsService, toolService);

		const testModels: ILanguageModelChatMetadata[] = [
			{ id: 'mae-4', name: 'MAE 4', vendor: 'olama', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-4.1', name: 'MAE 4.1', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'gpt-4', name: 'GPT 4', vendor: 'openai', version: '1.0', family: 'gpt', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: false, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
		];

		instaService.stub(ILanguageModelsService, {
			getLanguageModelIds() { return testModels.map(m => m.id); },
			lookupLanguageModel(name: string) {
				return testModels.find(m => m.id === name);
			}
		});

		const customAgent: ICustomAgent = {
			name: 'agent1',
			description: 'Agent file 1.',
			agentInstructions: {
				content: '',
				toolReferences: [],
				metadata: undefined
			},
			uri: URI.parse('myFs://.github/agents/agent1.agent.md'),
			source: { storage: PromptsStorage.local },
			visibility: { userInvokable: true, agentInvokable: true }
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHovers.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHovers.test.ts#L36-L76)

```

	setup(async () => {
		const testConfigService = new TestConfigurationService();
		testConfigService.setUserConfiguration(ChatConfiguration.ExtensionToolsEnabled, true);
		instaService = workbenchInstantiationService({
			contextKeyService: () => disposables.add(new ContextKeyService(testConfigService)),
			configurationService: () => testConfigService
		}, disposables);

		const toolService = disposables.add(instaService.createInstance(LanguageModelToolsService));

		const testTool1 = { id: 'testTool1', displayName: 'tool1', canBeReferencedInPrompt: true, modelDescription: 'Test Tool 1', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool1));

		const testTool2 = { id: 'testTool2', displayName: 'tool2', canBeReferencedInPrompt: true, toolReferenceName: 'tool2', modelDescription: 'Test Tool 2', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool2));

		instaService.set(ILanguageModelToolsService, toolService);

		const testModels: ILanguageModelChatMetadata[] = [
			{ id: 'mae-4', name: 'MAE 4', vendor: 'olama', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-4.1', name: 'MAE 4.1', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
		];

		instaService.stub(ILanguageModelsService, {
			getLanguageModelIds() { return testModels.map(m => m.id); },
			lookupLanguageModelByQualifiedName(qualifiedName: string) {
				for (const metadata of testModels) {
					if (ILanguageModelChatMetadata.matchesQualifiedName(qualifiedName, metadata)) {
						return metadata;
					}
				}
				return undefined;
			}
		});

		const customChatMode = new CustomChatMode({
			uri: URI.parse('myFs://test/test/chatmode.md'),
			name: 'BeastMode',
			agentInstructions: { content: 'Beast mode instructions', toolReferences: [] },
			source: { storage: PromptsStorage.local },
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHovers.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/promptSyntax/languageProviders/promptHovers.test.ts#L37-L77)

```
	setup(async () => {
		const testConfigService = new TestConfigurationService();
		testConfigService.setUserConfiguration(ChatConfiguration.ExtensionToolsEnabled, true);
		instaService = workbenchInstantiationService({
			contextKeyService: () => disposables.add(new ContextKeyService(testConfigService)),
			configurationService: () => testConfigService
		}, disposables);

		const toolService = disposables.add(instaService.createInstance(LanguageModelToolsService));

		const testTool1 = { id: 'testTool1', displayName: 'tool1', canBeReferencedInPrompt: true, modelDescription: 'Test Tool 1', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool1));

		const testTool2 = { id: 'testTool2', displayName: 'tool2', canBeReferencedInPrompt: true, toolReferenceName: 'tool2', modelDescription: 'Test Tool 2', source: ToolDataSource.External, inputSchema: {} } satisfies IToolData;
		disposables.add(toolService.registerToolData(testTool2));

		instaService.set(ILanguageModelToolsService, toolService);

		const testModels: ILanguageModelChatMetadata[] = [
			{ id: 'mae-4', name: 'MAE 4', vendor: 'olama', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
			{ id: 'mae-4.1', name: 'MAE 4.1', vendor: 'copilot', version: '1.0', family: 'mae', modelPickerCategory: undefined, extension: new ExtensionIdentifier('a.b'), isUserSelectable: true, maxInputTokens: 8192, maxOutputTokens: 1024, capabilities: { agentMode: true, toolCalling: true }, isDefaultForLocation: { [ChatAgentLocation.Chat]: true } } satisfies ILanguageModelChatMetadata,
		];

		instaService.stub(ILanguageModelsService, {
			getLanguageModelIds() { return testModels.map(m => m.id); },
			lookupLanguageModelByQualifiedName(qualifiedName: string) {
				for (const metadata of testModels) {
					if (ILanguageModelChatMetadata.matchesQualifiedName(qualifiedName, metadata)) {
						return metadata;
					}
				}
				return undefined;
			}
		});

		const customChatMode = new CustomChatMode({
			uri: URI.parse('myFs://test/test/chatmode.md'),
			name: 'BeastMode',
			agentInstructions: { content: 'Beast mode instructions', toolReferences: [] },
			source: { storage: PromptsStorage.local },
			visibility: { userInvokable: true, agentInvokable: true }
```
