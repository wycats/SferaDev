## Findings: tokenBudget|token.*budget in chat contrib
### Files Found
- [.reference/vscode/src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts](.reference/vscode/src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts#L170)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L76)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L348)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L1845)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L1869)
- [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L2846)

### Code Excerpts

#### [.reference/vscode/src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts](.reference/vscode/src/vs/workbench/contrib/chat/common/tools/languageModelToolsService.ts#L150-L190)

```
	}

	export function classify(source: ToolDataSource): { readonly ordinal: number; readonly label: string } {
		if (source.type === 'internal') {
			return { ordinal: 1, label: localize('builtin', 'Built-In') };
		} else if (source.type === 'mcp') {
			return { ordinal: 2, label: source.label };
		} else if (source.type === 'user') {
			return { ordinal: 0, label: localize('user', 'User Defined') };
		} else {
			return { ordinal: 3, label: source.label };
		}
	}
}

export interface IToolInvocation {
	callId: string;
	toolId: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	parameters: Record<string, any>;
	tokenBudget?: number;
	context: IToolInvocationContext | undefined;
	chatRequestId?: string;
	chatInteractionId?: string;
	/**
	 * Optional tool call ID from the chat stream, used to correlate with pending streaming tool calls.
	 */
	chatStreamToolCallId?: string;
	/**
	 * Lets us add some nicer UI to toolcalls that came from a sub-agent, but in the long run, this should probably just be rendered in a similar way to thinking text + tool call groups
	 */
	subAgentInvocationId?: string;
	toolSpecificData?: IChatTerminalToolInvocationData | IChatToolInputInvocationData | IChatExtensionsContent | IChatTodoListContent | IChatSubagentToolInvocationData;
	modelId?: string;
	userSelectedTools?: UserSelectedTools;
}

export interface IToolInvocationContext {
	/** @deprecated Use {@link sessionResource} instead */
	readonly sessionId: string;
	readonly sessionResource: URI;
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L56-L96)

```

	reset() {
		this.events = [];
	}
}

function registerToolForTest(service: LanguageModelToolsService, store: any, id: string, impl: IToolImpl, data?: Partial<IToolData>) {
	const toolData: IToolData = {
		id,
		modelDescription: data?.modelDescription ?? 'Test Tool',
		displayName: data?.displayName ?? 'Test Tool',
		source: ToolDataSource.Internal,
		...data,
	};
	store.add(service.registerTool(toolData, impl));
	return {
		id,
		makeDto: (parameters: any, context?: { sessionId: string }, callId: string = '1'): IToolInvocation => ({
			callId,
			toolId: id,
			tokenBudget: 100,
			parameters,
			context: context ? {
				sessionId: context.sessionId,
				sessionResource: LocalChatSessionUri.forSession(context.sessionId),
			} : undefined,
		}),
	};
}

function stubGetSession(chatService: MockChatService, sessionId: string, options?: { requestId?: string; capture?: { invocation?: any } }): IChatModel {
	const requestId = options?.requestId ?? 'requestId';
	const capture = options?.capture;
	const fakeModel = {
		sessionId,
		sessionResource: LocalChatSessionUri.forSession(sessionId),
		getRequests: () => [{ id: requestId, modelId: 'test-model' }],
	} as ChatModel;
	chatService.addSession(fakeModel);
	chatService.appendProgress = (request, progress) => {
		if (capture) { capture.invocation = progress; }
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L328-L368)

```
			displayName: 'Test Tool',
			source: ToolDataSource.Internal,
		};

		store.add(service.registerToolData(toolData));

		const toolImpl: IToolImpl = {
			invoke: async (invocation) => {
				assert.strictEqual(invocation.callId, '1');
				assert.strictEqual(invocation.toolId, 'testTool');
				assert.deepStrictEqual(invocation.parameters, { a: 1 });
				return { content: [{ kind: 'text', value: 'result' }] };
			}
		};

		store.add(service.registerToolImplementation('testTool', toolImpl));

		const dto: IToolInvocation = {
			callId: '1',
			toolId: 'testTool',
			tokenBudget: 100,
			parameters: {
				a: 1
			},
			context: undefined,
		};

		const result = await service.invokeTool(dto, async () => 0, CancellationToken.None);
		assert.strictEqual(result.content[0].value, 'result');
	});

	test('invocation parameters are overridden by input toolSpecificData', async () => {
		const rawInput = { b: 2 };
		const tool = registerToolForTest(service, store, 'testToolInputOverride', {
			prepareToolInvocation: async () => ({
				toolSpecificData: { kind: 'input', rawInput } satisfies IChatToolInputInvocationData,
				confirmationMessages: {
					title: 'a',
					message: 'b',
				}
			}),
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L1825-L1865)

```
			invoke: async () => ({ content: [] }),
		};

		const toolImpl2: IToolImpl = {
			invoke: async () => ({ content: [] }),
		};

		store.add(service.registerToolData(toolData));
		store.add(service.registerToolImplementation('testTool', toolImpl1));

		// Second implementation should throw
		assert.throws(() => {
			service.registerToolImplementation('testTool', toolImpl2);
		}, /Tool "testTool" already has an implementation/);
	});

	test('invokeTool with unknown tool throws', async () => {
		const dto: IToolInvocation = {
			callId: '1',
			toolId: 'unknownTool',
			tokenBudget: 100,
			parameters: {},
			context: undefined,
		};

		await assert.rejects(
			service.invokeTool(dto, async () => 0, CancellationToken.None),
			/Tool unknownTool was not contributed/
		);
	});

	test('invokeTool without implementation activates extension and throws if still not found', async () => {
		const toolData: IToolData = {
			id: 'extensionActivationTool',
			modelDescription: 'Extension Tool',
			displayName: 'Extension Tool',
			source: ToolDataSource.Internal,
		};

		store.add(service.registerToolData(toolData));

```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L1849-L1889)

```

		await assert.rejects(
			service.invokeTool(dto, async () => 0, CancellationToken.None),
			/Tool unknownTool was not contributed/
		);
	});

	test('invokeTool without implementation activates extension and throws if still not found', async () => {
		const toolData: IToolData = {
			id: 'extensionActivationTool',
			modelDescription: 'Extension Tool',
			displayName: 'Extension Tool',
			source: ToolDataSource.Internal,
		};

		store.add(service.registerToolData(toolData));

		const dto: IToolInvocation = {
			callId: '1',
			toolId: 'extensionActivationTool',
			tokenBudget: 100,
			parameters: {},
			context: undefined,
		};

		// Should throw after attempting extension activation
		await assert.rejects(
			service.invokeTool(dto, async () => 0, CancellationToken.None),
			/Tool extensionActivationTool does not have an implementation registered/
		);
	});

	test('invokeTool without context (non-chat scenario)', async () => {
		const tool = registerToolForTest(service, store, 'nonChatTool', {
			invoke: async (invocation) => {
				assert.strictEqual(invocation.context, undefined);
				return { content: [{ kind: 'text', value: 'non-chat result' }] };
			}
		});

		const dto = tool.makeDto({ test: 1 }); // No context
```

#### [.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts](.reference/vscode/src/vs/workbench/contrib/chat/test/browser/tools/languageModelToolsService.test.ts#L2826-L2866)

```

		const sessionId = 'correlated-session';
		const requestId = 'correlated-request';
		const capture: { invocation?: any } = {};
		stubGetSession(chatService, sessionId, { requestId, capture });

		// Start a streaming tool call
		const streamingInvocation = service.beginToolCall({
			toolCallId: 'stream-call-id',
			toolId: tool.id,
			chatRequestId: requestId,
			sessionResource: LocalChatSessionUri.forSession(sessionId),
		});

		assert.ok(streamingInvocation, 'should create streaming invocation');

		// Now invoke the tool with a different callId but matching chatStreamToolCallId
		const dto: IToolInvocation = {
			callId: 'different-call-id',
			toolId: tool.id,
			tokenBudget: 100,
			parameters: { test: 1 },
			context: {
				sessionId,
				sessionResource: LocalChatSessionUri.forSession(sessionId),
			},
			chatStreamToolCallId: 'stream-call-id', // This should correlate
		};

		const result = await service.invokeTool(dto, async () => 0, CancellationToken.None);
		assert.strictEqual(result.content[0].value, 'correlated result');
	});

	test('getAllToolsIncludingDisabled returns tools regardless of when clause', () => {
		contextKeyService.createKey('featureFlag', false);

		const enabledTool: IToolData = {
			id: 'enabledTool',
			modelDescription: 'Enabled Tool',
			displayName: 'Enabled Tool',
			source: ToolDataSource.Internal,
```
