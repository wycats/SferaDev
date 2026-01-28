import {
	type AuthenticationProvider,
	type AuthenticationProviderAuthenticationSessionsChangeEvent,
	type AuthenticationProviderSessionOptions,
	type AuthenticationSession,
	authentication,
	type Disposable,
	type Event,
	EventEmitter,
	type ExtensionContext,
	window,
} from "vscode";
import { ERROR_MESSAGES, EXTENSION_ID } from "./constants";
import { logger } from "./logger";
import {
	checkVercelCliAvailable,
	createInteractiveOidcSession,
	refreshOidcToken,
} from "./vercel-auth";

export const VERCEL_AI_AUTH_PROVIDER_ID = EXTENSION_ID;

const SESSIONS_SECRET_KEY = `${VERCEL_AI_AUTH_PROVIDER_ID}.sessions`;
const ACTIVE_SESSION_KEY = `${VERCEL_AI_AUTH_PROVIDER_ID}.activeSession`;

export type AuthenticationMethod = "api-key" | "oidc";

interface SessionData {
	id: string;
	accessToken: string;
	account: { id: string; label: string };
	scopes: readonly string[];
	method: AuthenticationMethod;
	oidcData?: {
		projectId: string;
		projectName: string;
		teamId?: string;
		teamName?: string;
		expiresAt: number;
	};
}

export class VercelAIAuthenticationProvider implements AuthenticationProvider, Disposable {
	private _sessionChangeEmitter =
		new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
	private _disposable: Disposable;

	constructor(private readonly context: ExtensionContext) {
		this._disposable = authentication.registerAuthenticationProvider(
			EXTENSION_ID,
			"Vercel AI Gateway",
			this,
			{ supportsMultipleAccounts: false },
		);
	}

	get onDidChangeSessions(): Event<AuthenticationProviderAuthenticationSessionsChangeEvent> {
		return this._sessionChangeEmitter.event;
	}

	dispose(): void {
		this._disposable.dispose();
		this._sessionChangeEmitter.dispose();
	}

	async getSessions(
		_scopes?: readonly string[],
		_options?: AuthenticationProviderSessionOptions,
	): Promise<AuthenticationSession[]> {
		const sessions = await this.getSessionsData();
		const { refreshedSessions, needsUpdate, changedSessions } =
			await this.refreshSessionTokens(sessions);

		if (needsUpdate) {
			await this.context.secrets.store(SESSIONS_SECRET_KEY, JSON.stringify(refreshedSessions));

			// Fire session change event for refreshed tokens
			if (changedSessions.length > 0) {
				const changedAuthSessions: AuthenticationSession[] = changedSessions.map((session) => ({
					id: session.id,
					accessToken: session.accessToken,
					account: session.account,
					scopes: [...session.scopes],
				}));
				this._sessionChangeEmitter.fire({
					added: [],
					removed: [],
					changed: changedAuthSessions,
				});
			}
		}

		// Sort sessions so the active session comes first
		const activeSessionId = await this.getActiveSessionId();
		const sortedSessions = [...refreshedSessions].sort((a, b) => {
			if (a.id === activeSessionId) {
				return -1;
			}
			if (b.id === activeSessionId) {
				return 1;
			}
			return 0;
		});

		return this.convertToAuthSessions(sortedSessions);
	}

	private async refreshSessionTokens(sessions: SessionData[]): Promise<{
		refreshedSessions: SessionData[];
		needsUpdate: boolean;
		changedSessions: SessionData[];
	}> {
		const refreshedSessions: SessionData[] = [];
		const changedSessions: SessionData[] = [];
		let needsUpdate = false;

		for (const session of sessions) {
			if (session.method === "oidc" && session.oidcData) {
				try {
					const refreshedSession = await this.refreshOidcSession(session);
					if (refreshedSession.accessToken !== session.accessToken) {
						needsUpdate = true;
						changedSessions.push(refreshedSession);
					}
					refreshedSessions.push(refreshedSession);
				} catch (error) {
					logger.error("Failed to refresh OIDC token in getSessions:", error);
					refreshedSessions.push(session);
				}
			} else {
				refreshedSessions.push(session);
			}
		}

		return { refreshedSessions, needsUpdate, changedSessions };
	}

	private async refreshOidcSession(session: SessionData): Promise<SessionData> {
		if (!session.oidcData) {
			return session;
		}

		const storedToken = {
			token: session.accessToken,
			expiresAt: session.oidcData.expiresAt,
			projectId: session.oidcData.projectId,
			projectName: session.oidcData.projectName,
			teamId: session.oidcData.teamId,
			teamName: session.oidcData.teamName,
		};

		const refreshedToken = await refreshOidcToken(storedToken);

		return {
			...session,
			accessToken: refreshedToken.token,
			oidcData: {
				...session.oidcData,
				expiresAt: refreshedToken.expiresAt,
				projectName: refreshedToken.projectName,
				teamName: refreshedToken.teamName,
			},
		};
	}

	private convertToAuthSessions(sessions: SessionData[]): AuthenticationSession[] {
		return sessions.map((session) => ({
			id: session.id,
			accessToken: session.accessToken,
			account: session.account,
			scopes: session.scopes,
		}));
	}

	private async getSessionsData(): Promise<SessionData[]> {
		const stored = await this.context.secrets.get(SESSIONS_SECRET_KEY);
		if (!stored) {
			return [];
		}

		try {
			const sessions = JSON.parse(stored) as SessionData[];
			return sessions.map((session) => ({
				...session,
				method: session.method || "api-key",
			}));
		} catch {
			await this.context.secrets.delete(SESSIONS_SECRET_KEY);
			return [];
		}
	}

	async createSession(_scopes: readonly string[]): Promise<AuthenticationSession> {
		const authMethod = await this.promptForAuthMethod();
		if (!authMethod) {
			throw new Error("Authentication method required");
		}

		return authMethod === "oidc" ? this.createOidcSession() : this.createApiKeySession();
	}

	private async createApiKeySession(): Promise<AuthenticationSession> {
		const sessionName = await this.promptForSessionName();
		if (!sessionName) {
			throw new Error("Session name required");
		}

		const apiKey = await this.promptForApiKey();
		if (!apiKey) {
			throw new Error("API key required");
		}

		const session: SessionData = {
			id: this.generateSessionId(),
			accessToken: apiKey,
			account: { id: "vercel-ai-user", label: sessionName },
			scopes: [],
			method: "api-key",
		};

		await this.storeSession(session);
		return session;
	}

	private async createOidcSession(): Promise<AuthenticationSession> {
		if (!checkVercelCliAvailable()) {
			window.showErrorMessage(ERROR_MESSAGES.VERCEL_CLI_NOT_LOGGED_IN);
			throw new Error(ERROR_MESSAGES.VERCEL_CLI_NOT_LOGGED_IN);
		}

		const storedToken = await createInteractiveOidcSession();

		const teamLabel = storedToken.teamName ? ` (${storedToken.teamName})` : "";
		const session: SessionData = {
			id: this.generateSessionId(),
			accessToken: storedToken.token,
			account: {
				id: "vercel-oidc-user",
				label: `${storedToken.projectName}${teamLabel}`,
			},
			scopes: [],
			method: "oidc",
			oidcData: {
				projectId: storedToken.projectId,
				projectName: storedToken.projectName,
				teamId: storedToken.teamId,
				teamName: storedToken.teamName,
				expiresAt: storedToken.expiresAt,
			},
		};

		await this.storeSession(session);
		return session;
	}

	private async storeSession(session: SessionData): Promise<void> {
		const existingSessions = await this.getSessionsData();
		const sessions = [...existingSessions, session];
		await this.context.secrets.store(SESSIONS_SECRET_KEY, JSON.stringify(sessions));

		await this.setActiveSession(session.id);

		this._sessionChangeEmitter.fire({
			added: [session],
			removed: [],
			changed: [],
		});
		window.showInformationMessage("Authentication successful!");
	}

	async removeSession(sessionId: string): Promise<void> {
		const sessions = await this.getSessionsData();
		const index = sessions.findIndex((s) => s.id === sessionId);

		if (index === -1) {
			return;
		}

		const [removed] = sessions.splice(index, 1);
		await this.context.secrets.store(SESSIONS_SECRET_KEY, JSON.stringify(sessions));

		const activeSessionId = await this.getActiveSessionId();
		if (activeSessionId === sessionId) {
			const newActiveSession = sessions.length > 0 ? sessions[0].id : null;
			await this.setActiveSession(newActiveSession);
			if (newActiveSession) {
				const newActive = sessions[0];
				const methodLabel = this.getMethodLabel(newActive.method);
				window.showInformationMessage(`Activated: ${newActive.account.label} ${methodLabel}`);
			}
		}

		const removedAuthSession: AuthenticationSession = {
			id: removed.id,
			accessToken: removed.accessToken,
			account: removed.account,
			scopes: removed.scopes,
		};
		this._sessionChangeEmitter.fire({
			added: [],
			removed: [removedAuthSession],
			changed: [],
		});
		window.showInformationMessage("Session removed");
	}

	private async promptForSessionName(): Promise<string | undefined> {
		return window.showInputBox({
			prompt: "Enter a name for this session",
			placeHolder: "e.g., Personal, Work, Project Name",
			ignoreFocusOut: true,
			validateInput: this.validateSessionName,
		});
	}

	private async promptForApiKey(): Promise<string | undefined> {
		return window.showInputBox({
			prompt: "Enter your Vercel AI Gateway API key",
			password: true,
			placeHolder: "vck_...",
			ignoreFocusOut: true,
			validateInput: this.validateApiKey,
		});
	}

	private validateSessionName(value: string): string | null {
		return !value?.trim() ? "Session name required" : null;
	}

	private validateApiKey(value: string): string | null {
		if (!value?.trim()) {
			return "API key required";
		}
		if (!value.startsWith("vck_")) {
			return 'API key must start with "vck_"';
		}
		return null;
	}

	private generateSessionId(): string {
		return `${EXTENSION_ID}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
	}

	private getMethodLabel(method: AuthenticationMethod): string {
		return method === "oidc" ? "[OIDC]" : "[API Key]";
	}

	async manageAuthentication(): Promise<void> {
		try {
			const sessions = await this.getSessionsData();
			if (sessions.length === 0) {
				await this.createSession([]);
				return;
			}

			const action = await this.promptForAction(sessions);
			await this.executeAction(action, sessions);
		} catch (error) {
			logger.error("Error in manage authentication:", error);
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			window.showErrorMessage(`Authentication management failed: ${errorMessage}`);
		}
	}

	private async promptForAuthMethod(): Promise<AuthenticationMethod | undefined> {
		const options = [
			{
				label: "API Key",
				description: "Manual API key entry",
				value: "api-key" as AuthenticationMethod,
			},
		];

		// Only show OIDC option if Vercel CLI is logged in
		if (checkVercelCliAvailable()) {
			options.push({
				label: "Vercel OIDC",
				description: "Use a Vercel OIDC project token",
				value: "oidc" as AuthenticationMethod,
			});
		}

		const result = await window.showQuickPick(options, {
			placeHolder: "Select authentication method",
		});
		return result?.value;
	}

	private async promptForAction(sessions: SessionData[]): Promise<string | undefined> {
		const activeSession = await this.getActiveSession();
		const methodLabel = activeSession ? this.getMethodLabel(activeSession.method) : "";
		const activeSessionName = activeSession
			? `${activeSession.account.label} ${methodLabel}`
			: "None";

		const options = [{ label: "Add new authentication", value: "add" }];
		if (sessions.length > 1) {
			options.push({ label: "Switch active session", value: "switch" });
		}
		options.push(
			{ label: "Remove session", value: "remove" },
			{ label: "Cancel", value: "cancel" },
		);

		const result = await window.showQuickPick(options, {
			placeHolder: `Active session: ${activeSessionName} - Choose an action`,
		});
		return result?.value;
	}

	private async executeAction(action: string | undefined, sessions: SessionData[]): Promise<void> {
		if (!action || action === "cancel") {
			window.showInformationMessage("Authentication management cancelled.");
			return;
		}

		try {
			switch (action) {
				case "add":
					await this.createSession([]);
					break;
				case "switch":
					await this.switchActiveSession();
					break;
				case "remove":
					await this.handleRemoveSession(sessions);
					break;
				default:
					window.showWarningMessage(`Unknown action: ${action}`);
			}
		} catch (error) {
			logger.error(`Error executing action ${action}:`, error);
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";

			if (
				errorMessage.includes("OIDC authentication failed") ||
				errorMessage.includes("No valid Vercel CLI authentication")
			) {
				return;
			}

			window.showErrorMessage(`Failed to ${action} session: ${errorMessage}`);
		}
	}

	private async handleRemoveSession(sessions: SessionData[]): Promise<void> {
		if (sessions.length === 1) {
			await this.removeSession(sessions[0].id);
			return;
		}

		const selected = await window.showQuickPick(
			sessions.map((s) => ({
				label: `${s.account.label} ${this.getMethodLabel(s.method)}`,
				value: s.id,
			})),
			{ placeHolder: "Select session to remove" },
		);
		if (selected) {
			await this.removeSession(selected.value);
		}
	}

	async getActiveSession(): Promise<SessionData | null> {
		const sessions = await this.getSessionsData();
		if (sessions.length === 0) {
			return null;
		}

		const activeSessionId = await this.getActiveSessionId();
		let activeSession: SessionData | undefined;

		if (activeSessionId) {
			activeSession = sessions.find((s) => s.id === activeSessionId);
		}

		// Fall back to first session if active session not found
		if (!activeSession) {
			activeSession = sessions[0];
		}

		// Refresh OIDC token if needed
		if (activeSession.method === "oidc" && activeSession.oidcData) {
			try {
				const refreshedSession = await this.refreshOidcSession(activeSession);
				if (refreshedSession.accessToken !== activeSession.accessToken) {
					// Update the stored session with refreshed token
					await this.updateStoredSession(refreshedSession);
				}
				return refreshedSession;
			} catch (error) {
				logger.error("Failed to refresh OIDC token in getActiveSession:", error);
				// Return the original session if refresh fails
				return activeSession;
			}
		}

		return activeSession;
	}

	private async updateStoredSession(updatedSession: SessionData): Promise<void> {
		const sessions = await this.getSessionsData();
		const index = sessions.findIndex((s) => s.id === updatedSession.id);

		if (index !== -1) {
			sessions[index] = updatedSession;
			await this.context.secrets.store(SESSIONS_SECRET_KEY, JSON.stringify(sessions));

			// Fire session change event to notify VS Code of the token update
			const authSession: AuthenticationSession = {
				id: updatedSession.id,
				accessToken: updatedSession.accessToken,
				account: updatedSession.account,
				scopes: [...updatedSession.scopes],
			};
			this._sessionChangeEmitter.fire({
				added: [],
				removed: [],
				changed: [authSession],
			});
		}
	}

	private async getActiveSessionId(): Promise<string | null> {
		return this.context.globalState.get(ACTIVE_SESSION_KEY, null);
	}

	private async setActiveSession(sessionId: string | null): Promise<void> {
		await this.context.globalState.update(ACTIVE_SESSION_KEY, sessionId);
	}

	private async switchActiveSession(): Promise<void> {
		const sessions = await this.getSessionsData();
		if (sessions.length <= 1) {
			window.showInformationMessage("You need at least 2 sessions to switch between them.");
			return;
		}

		const activeSessionId = await this.getActiveSessionId();

		const options = sessions.map((s) => ({
			label: `${s.account.label} ${this.getMethodLabel(s.method)}`,
			description: s.id === activeSessionId ? "(currently active)" : "",
			value: s.id,
		}));

		const selected = await window.showQuickPick(options, {
			placeHolder: "Select session to activate",
		});

		if (!selected) {
			return;
		}

		if (selected.value === activeSessionId) {
			window.showInformationMessage("Session is already active.");
			return;
		}

		await this.setActiveSession(selected.value);
		const selectedSession = sessions.find((s) => s.id === selected.value);
		const methodLabel = selectedSession ? this.getMethodLabel(selectedSession.method) : "";

		// Fire session change event to notify VS Code that sessions have changed
		if (selectedSession) {
			const authSession: AuthenticationSession = {
				id: selectedSession.id,
				accessToken: selectedSession.accessToken,
				account: selectedSession.account,
				scopes: selectedSession.scopes,
			};
			this._sessionChangeEmitter.fire({
				added: [],
				removed: [],
				changed: [authSession],
			});
		}
		window.showInformationMessage(`Switched to: ${selectedSession?.account.label} ${methodLabel}`);
	}
}
