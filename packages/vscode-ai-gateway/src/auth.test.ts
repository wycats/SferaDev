import { beforeEach, describe, expect, it, vi } from "vitest";

// Create hoisted mock functions
const hoisted = vi.hoisted(() => {
  const mockEventEmitterFire = vi.fn();
  const mockEventEmitterDispose = vi.fn();
  const mockEventEmitterEvent = vi.fn();
  const mockDisposable = { dispose: vi.fn() };

  class MockEventEmitter {
    event = mockEventEmitterEvent;
    fire = mockEventEmitterFire;
    dispose = mockEventEmitterDispose;
  }

  const mockRegisterAuthProvider = vi.fn(() => mockDisposable);
  const mockShowInputBox = vi.fn();
  const mockShowQuickPick = vi.fn();
  const mockShowInformationMessage = vi.fn();
  const mockShowErrorMessage = vi.fn();
  const mockShowWarningMessage = vi.fn();

  return {
    mockEventEmitterFire,
    mockEventEmitterDispose,
    mockEventEmitterEvent,
    MockEventEmitter,
    mockRegisterAuthProvider,
    mockDisposable,
    mockShowInputBox,
    mockShowQuickPick,
    mockShowInformationMessage,
    mockShowErrorMessage,
    mockShowWarningMessage,
  };
});

// Mock vscode module
vi.mock("vscode", () => ({
  EventEmitter: hoisted.MockEventEmitter,
  authentication: {
    registerAuthenticationProvider: hoisted.mockRegisterAuthProvider,
  },
  window: {
    showInputBox: hoisted.mockShowInputBox,
    showQuickPick: hoisted.mockShowQuickPick,
    showInformationMessage: hoisted.mockShowInformationMessage,
    showErrorMessage: hoisted.mockShowErrorMessage,
    showWarningMessage: hoisted.mockShowWarningMessage,
  },
}));

// Mock vercel-auth module
vi.mock("./vercel-auth", () => ({
  checkVercelCliAvailable: vi.fn(),
  createInteractiveOidcSession: vi.fn(),
  refreshOidcToken: vi.fn(),
}));

import type {
  AuthenticationProviderAuthenticationSessionsChangeEvent,
  ExtensionContext,
} from "vscode";
import { VercelAIAuthenticationProvider } from "./auth";
import { checkVercelCliAvailable, refreshOidcToken } from "./vercel-auth";

interface StoredSessionData {
  id: string;
}

// Helper to create a mock ExtensionContext
function createMockContext(): ExtensionContext {
  const secrets = new Map<string, string>();
  const globalState = new Map<string, unknown>();

  return {
    secrets: {
      get: vi.fn((key: string) => Promise.resolve(secrets.get(key))),
      store: vi.fn((key: string, value: string) => {
        secrets.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        secrets.delete(key);
        return Promise.resolve();
      }),
      onDidChange: vi.fn(),
    },
    globalState: {
      get: vi.fn(
        (key: string, defaultValue?: unknown) =>
          globalState.get(key) ?? defaultValue,
      ),
      update: vi.fn((key: string, value: unknown) => {
        globalState.set(key, value);
        return Promise.resolve();
      }),
      keys: vi.fn(() => Array.from(globalState.keys())),
      setKeysForSync: vi.fn(),
    },
    subscriptions: [],
  } as unknown as ExtensionContext;
}

// Helper to create session data for testing
function createTestSessionData(
  overrides: {
    id?: string;
    method?: "api-key" | "oidc";
    accessToken?: string;
    expiresAt?: number;
    accountLabel?: string;
  } = {},
) {
  const id = overrides.id ?? `test-session-${Date.now().toString()}`;
  const method = overrides.method ?? "api-key";
  const accessToken = overrides.accessToken ?? "vck_test_token";

  const session = {
    id,
    accessToken,
    account: {
      id: "test-user",
      label: overrides.accountLabel ?? "Test Session",
    },
    scopes: [],
    method,
  };

  if (method === "oidc") {
    return {
      ...session,
      oidcData: {
        projectId: "proj_123",
        projectName: "Test Project",
        teamId: "team_123",
        teamName: "Test Team",
        expiresAt: overrides.expiresAt ?? Date.now() + 60 * 60 * 1000,
      },
    };
  }

  return session;
}

describe("VercelAIAuthenticationProvider", () => {
  let mockContext: ExtensionContext;
  let authProvider: VercelAIAuthenticationProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = createMockContext();
    authProvider = new VercelAIAuthenticationProvider(mockContext);
    vi.mocked(checkVercelCliAvailable).mockReturnValue(false);
  });

  describe("getSessions", () => {
    it("should return empty array when no sessions exist", async () => {
      const sessions = await authProvider.getSessions();
      expect(sessions).toEqual([]);
    });

    it("should return stored sessions", async () => {
      const testSession = createTestSessionData({ id: "session-1" });
      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        JSON.stringify([testSession]),
      );

      const sessions = await authProvider.getSessions();
      expect(sessions).toHaveLength(1);
      const session = sessions[0];
      expect(session).toBeDefined();
      if (!session) {
        throw new Error("Expected session to be defined");
      }
      expect(session.id).toBe("session-1");
    });

    it("should refresh OIDC tokens that are near expiration", async () => {
      const nearExpirySession = createTestSessionData({
        id: "oidc-session",
        method: "oidc",
        accessToken: "old_oidc_token",
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        JSON.stringify([nearExpirySession]),
      );

      vi.mocked(refreshOidcToken).mockResolvedValueOnce({
        token: "new_oidc_token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        projectId: "proj_123",
        projectName: "Test Project",
        teamId: "team_123",
        teamName: "Test Team",
      });

      const sessions = await authProvider.getSessions();

      expect(refreshOidcToken).toHaveBeenCalled();
      const session = sessions[0];
      expect(session).toBeDefined();
      if (!session) {
        throw new Error("Expected session to be defined");
      }
      expect(session.accessToken).toBe("new_oidc_token");
    });

    it("should fire session change event when tokens are refreshed", async () => {
      const nearExpirySession = createTestSessionData({
        id: "oidc-session",
        method: "oidc",
        accessToken: "old_token",
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        JSON.stringify([nearExpirySession]),
      );

      vi.mocked(refreshOidcToken).mockResolvedValueOnce({
        token: "refreshed_token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        projectId: "proj_123",
        projectName: "Test Project",
        teamId: "team_123",
        teamName: "Test Team",
      });

      await authProvider.getSessions();

      const changedMatcher = expect.arrayContaining([
        expect.objectContaining({ accessToken: "refreshed_token" }),
      ]) as AuthenticationProviderAuthenticationSessionsChangeEvent["changed"];

      expect(hoisted.mockEventEmitterFire).toHaveBeenCalledWith(
        expect.objectContaining({
          changed: changedMatcher,
        }),
      );
    });
  });

  describe("getActiveSession - Bug #1 Fix Verification", () => {
    it("should return null when no sessions exist", async () => {
      const activeSession = await authProvider.getActiveSession();
      expect(activeSession).toBeNull();
    });

    it("should refresh OIDC token when getting active session (Bug #1 fix)", async () => {
      const nearExpirySession = createTestSessionData({
        id: "oidc-session",
        method: "oidc",
        accessToken: "old_expired_token",
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        JSON.stringify([nearExpirySession]),
      );
      await mockContext.globalState.update(
        "vercelAiGateway.activeSession",
        "oidc-session",
      );

      vi.mocked(refreshOidcToken).mockResolvedValueOnce({
        token: "fresh_token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        projectId: "proj_123",
        projectName: "Test Project",
        teamId: "team_123",
        teamName: "Test Team",
      });

      const activeSession = await authProvider.getActiveSession();

      // Verify Bug #1 is fixed: getActiveSession now refreshes OIDC tokens
      expect(refreshOidcToken).toHaveBeenCalled();
      expect(activeSession?.accessToken).toBe("fresh_token");
    });

    it("should update stored session and fire event after refresh", async () => {
      const nearExpirySession = createTestSessionData({
        id: "oidc-session",
        method: "oidc",
        accessToken: "old_token",
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        JSON.stringify([nearExpirySession]),
      );
      await mockContext.globalState.update(
        "vercelAiGateway.activeSession",
        "oidc-session",
      );

      vi.mocked(refreshOidcToken).mockResolvedValueOnce({
        token: "fresh_token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        projectId: "proj_123",
        projectName: "Test Project",
        teamId: "team_123",
        teamName: "Test Team",
      });

      await authProvider.getActiveSession();

      // Verify session change event was fired
      const changedMatcher = expect.arrayContaining([
        expect.objectContaining({ accessToken: "fresh_token" }),
      ]) as AuthenticationProviderAuthenticationSessionsChangeEvent["changed"];

      expect(hoisted.mockEventEmitterFire).toHaveBeenCalledWith(
        expect.objectContaining({
          changed: changedMatcher,
        }),
      );
    });

    it("should return original session when refresh fails", async () => {
      const nearExpirySession = createTestSessionData({
        id: "oidc-session",
        method: "oidc",
        accessToken: "original_token",
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        JSON.stringify([nearExpirySession]),
      );

      vi.mocked(refreshOidcToken).mockRejectedValueOnce(
        new Error("Network error"),
      );

      const activeSession = await authProvider.getActiveSession();

      expect(activeSession?.accessToken).toBe("original_token");
    });
  });

  describe("removeSession", () => {
    it("should remove a session and update storage", async () => {
      const session1 = createTestSessionData({ id: "session-1" });
      const session2 = createTestSessionData({ id: "session-2" });

      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        JSON.stringify([session1, session2]),
      );

      await authProvider.removeSession("session-1");

      const storedSessions = JSON.parse(
        (await mockContext.secrets.get("vercelAiGateway.sessions")) ?? "[]",
      ) as StoredSessionData[];
      expect(storedSessions).toHaveLength(1);
      const storedSession = storedSessions[0];
      expect(storedSession).toBeDefined();
      if (!storedSession) {
        throw new Error("Expected stored session to be defined");
      }
      expect(storedSession.id).toBe("session-2");
    });

    it("should fire session change event when session is removed", async () => {
      const session = createTestSessionData({ id: "session-1" });
      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        JSON.stringify([session]),
      );

      await authProvider.removeSession("session-1");

      const removedMatcher = expect.arrayContaining([
        expect.objectContaining({ id: "session-1" }),
      ]) as AuthenticationProviderAuthenticationSessionsChangeEvent["removed"];

      expect(hoisted.mockEventEmitterFire).toHaveBeenCalledWith(
        expect.objectContaining({
          removed: removedMatcher,
        }),
      );
    });
  });

  describe("createSession", () => {
    it("should create an API key session when selected", async () => {
      hoisted.mockShowQuickPick.mockResolvedValueOnce({
        label: "API Key",
        value: "api-key",
      } as never);
      hoisted.mockShowInputBox
        .mockResolvedValueOnce("My Session")
        .mockResolvedValueOnce("vck_test_key");

      const session = await authProvider.createSession([]);

      expect(session.accessToken).toBe("vck_test_key");
      expect(session.account.label).toBe("My Session");
    });

    it("should throw error when auth method is not selected", async () => {
      hoisted.mockShowQuickPick.mockResolvedValueOnce(undefined);

      await expect(authProvider.createSession([])).rejects.toThrow(
        "Authentication method required",
      );
    });
  });

  describe("session data persistence", () => {
    it("should handle corrupted session data gracefully", async () => {
      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        "invalid json{",
      );

      const sessions = await authProvider.getSessions();

      expect(sessions).toEqual([]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(mockContext.secrets.delete).toHaveBeenCalledWith(
        "vercelAiGateway.sessions",
      );
    });
  });

  describe("OIDC session handling", () => {
    it("should handle refresh token failure gracefully", async () => {
      const nearExpirySession = createTestSessionData({
        id: "oidc-session",
        method: "oidc",
        accessToken: "expiring_token",
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      await mockContext.secrets.store(
        "vercelAiGateway.sessions",
        JSON.stringify([nearExpirySession]),
      );

      vi.mocked(refreshOidcToken).mockRejectedValueOnce(
        new Error("Refresh failed"),
      );

      const sessions = await authProvider.getSessions();

      expect(sessions).toHaveLength(1);
      const session = sessions[0];
      expect(session).toBeDefined();
      if (!session) {
        throw new Error("Expected session to be defined");
      }
      expect(session.accessToken).toBe("expiring_token");
    });
  });
});
