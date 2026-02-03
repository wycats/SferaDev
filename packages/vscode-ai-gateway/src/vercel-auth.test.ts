import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:fs
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
}));

// Mock node:os
vi.mock("node:os", () => ({
	platform: vi.fn(),
	homedir: vi.fn(),
}));

// Mock vscode
vi.mock("vscode", () => ({
	window: {
		showQuickPick: vi.fn(),
		showInputBox: vi.fn(),
		showErrorMessage: vi.fn(),
	},
}));

// Store original fetch
const originalFetch = global.fetch;

describe("vercel-auth", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.mocked(os.platform).mockReturnValue("darwin");
		vi.mocked(os.homedir).mockReturnValue("/Users/testuser");
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	describe("getTokenPayload - BUG #3: Missing validation for JWT exp field", () => {
		// Helper to create a JWT token
		function createJwtToken(payload: Record<string, unknown>): string {
			const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
				"base64url",
			);
			const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url");
			return `${header}.${payloadStr}.signature`;
		}

		it("should parse valid JWT token with exp field", async () => {
			// Setup CLI token
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "cli_token" }));

			const expTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
			const validToken = createJwtToken({ exp: expTime, sub: "user123" });

			// Mock fetch to return the token
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ token: validToken }),
			});

			// Import dynamically to get fresh module with mocks
			const { refreshOidcToken } = await import("./vercel-auth");

			const storedToken = {
				token: "old_token",
				expiresAt: Date.now() - 1000, // Already expired
				projectId: "proj_123",
				projectName: "Test Project",
			};

			const result = await refreshOidcToken(storedToken);

			expect(result.token).toBe(validToken);
			expect(result.expiresAt).toBe(expTime * 1000);
		});

		it("BUG: should handle JWT token without exp field gracefully", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "cli_token" }));

			// Token without exp field
			const tokenWithoutExp = createJwtToken({ sub: "user123", iat: Date.now() / 1000 });

			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ token: tokenWithoutExp }),
			});

			const { refreshOidcToken } = await import("./vercel-auth");

			const storedToken = {
				token: "old_token",
				expiresAt: Date.now() - 1000,
				projectId: "proj_123",
				projectName: "Test Project",
			};

			// This test will expose the bug - when exp is undefined,
			// payload.exp * 1000 will be NaN
			const result = await refreshOidcToken(storedToken);

			// The expiresAt should NOT be NaN
			expect(Number.isNaN(result.expiresAt)).toBe(false);
			// Should have a reasonable default expiration
			expect(result.expiresAt).toBeGreaterThan(Date.now());
		});

		it("BUG: should handle malformed JWT token gracefully", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "cli_token" }));

			// Malformed token (not valid base64)
			const malformedToken = "not.a.valid.jwt.token";

			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ token: malformedToken }),
			});

			const { refreshOidcToken } = await import("./vercel-auth");

			const storedToken = {
				token: "old_token",
				expiresAt: Date.now() - 1000,
				projectId: "proj_123",
				projectName: "Test Project",
			};

			// Should throw a meaningful error for invalid JWT
			await expect(refreshOidcToken(storedToken)).rejects.toThrow();
		});
	});

	describe("checkVercelCliAvailable", () => {
		it("should return true when CLI token exists", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "valid_token" }));

			const { checkVercelCliAvailable } = await import("./vercel-auth");

			expect(checkVercelCliAvailable()).toBe(true);
		});

		it("should return false when CLI token file does not exist", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const { checkVercelCliAvailable } = await import("./vercel-auth");

			expect(checkVercelCliAvailable()).toBe(false);
		});

		it("should return false when CLI token file is corrupted", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue("invalid json{");

			const { checkVercelCliAvailable } = await import("./vercel-auth");

			expect(checkVercelCliAvailable()).toBe(false);
		});

		it("should handle different platforms correctly", async () => {
			// Test Linux
			vi.mocked(os.platform).mockReturnValue("linux");
			vi.mocked(os.homedir).mockReturnValue("/home/testuser");
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "token" }));

			const { checkVercelCliAvailable } = await import("./vercel-auth");

			expect(checkVercelCliAvailable()).toBe(true);
			expect(fs.existsSync).toHaveBeenCalledWith(
				expect.stringContaining(".local/share/com.vercel.cli/auth.json"),
			);
		});
	});

	describe("refreshOidcToken", () => {
		it("should not refresh token that is not expired", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "cli_token" }));

			global.fetch = vi.fn();

			const { refreshOidcToken } = await import("./vercel-auth");

			const storedToken = {
				token: "valid_token",
				expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
				projectId: "proj_123",
				projectName: "Test Project",
			};

			const result = await refreshOidcToken(storedToken);

			// Should return the same token without making a network call
			expect(result).toEqual(storedToken);
			expect(global.fetch).not.toHaveBeenCalled();
		});

		it("should refresh token when within margin of expiration", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "cli_token" }));

			const expTime = Math.floor(Date.now() / 1000) + 3600;
			const newToken =
				Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url") +
				"." +
				Buffer.from(JSON.stringify({ exp: expTime })).toString("base64url") +
				".sig";

			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ token: newToken }),
			});

			const { refreshOidcToken } = await import("./vercel-auth");

			const storedToken = {
				token: "old_token",
				expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes - within 15 min margin
				projectId: "proj_123",
				projectName: "Test Project",
				teamId: "team_123",
				teamName: "Test Team",
			};

			const result = await refreshOidcToken(storedToken);

			expect(global.fetch).toHaveBeenCalled();
			expect(result.token).toBe(newToken);
			// Verify teamId and teamName are preserved
			expect(result.teamId).toBe("team_123");
			expect(result.teamName).toBe("Test Team");
		});

		it("should throw error when Vercel CLI is not logged in", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const { refreshOidcToken } = await import("./vercel-auth");

			const storedToken = {
				token: "old_token",
				expiresAt: Date.now() - 1000, // Expired
				projectId: "proj_123",
				projectName: "Test Project",
			};

			await expect(refreshOidcToken(storedToken)).rejects.toThrow("Vercel CLI not logged in");
		});

		it("should throw error when API returns non-ok response", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "cli_token" }));

			global.fetch = vi.fn().mockResolvedValue({
				ok: false,
				statusText: "Unauthorized",
			});

			const { refreshOidcToken } = await import("./vercel-auth");

			const storedToken = {
				token: "old_token",
				expiresAt: Date.now() - 1000,
				projectId: "proj_123",
				projectName: "Test Project",
			};

			await expect(refreshOidcToken(storedToken)).rejects.toThrow("Failed to refresh OIDC token");
		});
	});

	describe("selectTeam - BUG #4: Empty teams list handling", () => {
		it("BUG: should handle empty teams list by allowing personal account selection", async () => {
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "cli_token" }));

			// API returns empty teams array
			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ teams: [] }),
			});

			const { window } = await import("vscode");

			// Currently, if there are no teams, the user can't select "personal account"
			// The quick pick will just be empty
			vi.mocked(window.showQuickPick).mockResolvedValue(undefined);

			const { createInteractiveOidcSession } = await import("./vercel-auth");

			// When teams array is empty, user should still be able to proceed
			// with personal account (team = null)
			// This test exposes that the current implementation doesn't provide
			// a clear "Personal Account" option when no teams exist
			await expect(createInteractiveOidcSession()).rejects.not.toThrow("Failed to load teams");
		});
	});

	describe("isExpired", () => {
		it("should consider token expired when within refresh margin", async () => {
			// Token expiring in 10 minutes should be considered "expired"
			// because TOKEN_REFRESH_MARGIN is 15 minutes
			const tokenExpiringIn10Min = Date.now() + 10 * 60 * 1000;

			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ token: "cli_token" }));

			const expTime = Math.floor(Date.now() / 1000) + 3600;
			const newToken =
				Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url") +
				"." +
				Buffer.from(JSON.stringify({ exp: expTime })).toString("base64url") +
				".sig";

			global.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ token: newToken }),
			});

			const { refreshOidcToken } = await import("./vercel-auth");

			const storedToken = {
				token: "token_to_refresh",
				expiresAt: tokenExpiringIn10Min,
				projectId: "proj_123",
				projectName: "Test Project",
			};

			// Should trigger refresh because token is within 15 min margin
			const result = await refreshOidcToken(storedToken);
			expect(global.fetch).toHaveBeenCalled();
			expect(result.token).not.toBe("token_to_refresh");
		});

		it("should not consider token expired when outside refresh margin", async () => {
			// Token expiring in 30 minutes should NOT be considered "expired"
			const tokenExpiringIn30Min = Date.now() + 30 * 60 * 1000;

			global.fetch = vi.fn();

			const { refreshOidcToken } = await import("./vercel-auth");

			const storedToken = {
				token: "valid_token",
				expiresAt: tokenExpiringIn30Min,
				projectId: "proj_123",
				projectName: "Test Project",
			};

			const result = await refreshOidcToken(storedToken);

			// Should NOT trigger refresh
			expect(global.fetch).not.toHaveBeenCalled();
			expect(result.token).toBe("valid_token");
		});
	});
});
