# RFC 011: Authentication

**Status:** Triage  
**Author:** Vercel AI Team  
**Created:** 2026-01-27  
**Updated:** 2026-01-27

## Summary

Define authentication methods for the VS Code extension, including API key authentication and enterprise OIDC support.

## Motivation

Enterprise environments require OIDC integration, while individual users rely on API keys stored in VS Code’s secure storage. Both methods must be supported under a unified configuration surface.

## Detailed Design

### Authentication Method Selection

The configuration key `vercel.ai.authentication.method` selects the active method:

- `apiKey` (default)
- `oidc`

### API Key Authentication

API key authentication uses VS Code’s secure storage and the existing sign-in flow:

- Store API keys in `context.secrets`
- Prompt users through the Command Palette
- Respect the active gateway endpoint from `vercel.ai.gateway.endpoint`

### OIDC Authentication

```typescript
// src/auth/oidc.ts

import * as vscode from "vscode";

export interface OIDCConfig {
  issuer: string;
  clientId: string;
  scopes: string[];
}

export class OIDCAuthenticationProvider
  implements vscode.AuthenticationProvider
{
  static readonly id = "vercel.ai.auth.oidc";
  static readonly label = "Vercel AI (OIDC)";

  private _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  private sessions: vscode.AuthenticationSession[] = [];
  private config: OIDCConfig;

  constructor(private context: vscode.ExtensionContext) {
    this.config = this.loadConfig();

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vercel.ai.authentication.oidc")) {
        this.config = this.loadConfig();
      }
    });
  }

  private loadConfig(): OIDCConfig {
    const config = vscode.workspace.getConfiguration(
      "vercel.ai.authentication.oidc",
    );
    return {
      issuer: config.get("issuer", ""),
      clientId: config.get("clientId", ""),
      scopes: config.get("scopes", ["openid", "profile"]),
    };
  }

  async getSessions(
    scopes?: readonly string[],
  ): Promise<readonly vscode.AuthenticationSession[]> {
    if (!scopes || scopes.length === 0) {
      return this.sessions;
    }
    return this.sessions.filter((session) =>
      scopes.every((scope) => session.scopes.includes(scope)),
    );
  }

  async createSession(
    scopes: readonly string[],
  ): Promise<vscode.AuthenticationSession> {
    if (!this.config.issuer || !this.config.clientId) {
      throw new Error(
        "OIDC not configured. Set vercel.ai.authentication.oidc.issuer and clientId.",
      );
    }

    const discovery = await this.discoverEndpoints();
    const { code, codeVerifier } = await this.startAuthorizationFlow(
      discovery,
      scopes,
    );
    const tokens = await this.exchangeCode(discovery, code, codeVerifier);

    const session: vscode.AuthenticationSession = {
      id: crypto.randomUUID(),
      accessToken: tokens.access_token,
      account: {
        id: tokens.sub || "unknown",
        label: tokens.email || tokens.name || "OIDC User",
      },
      scopes: [...scopes],
    };

    this.sessions.push(session);
    this._onDidChangeSessions.fire({
      added: [session],
      removed: [],
      changed: [],
    });

    if (tokens.refresh_token) {
      await this.context.secrets.store(
        `vercel.ai.oidc.refresh.${session.id}`,
        tokens.refresh_token,
      );
    }

    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const index = this.sessions.findIndex((s) => s.id === sessionId);
    if (index >= 0) {
      const [removed] = this.sessions.splice(index, 1);
      await this.context.secrets.delete(`vercel.ai.oidc.refresh.${sessionId}`);
      this._onDidChangeSessions.fire({
        added: [],
        removed: [removed],
        changed: [],
      });
    }
  }

  private async discoverEndpoints(): Promise<OIDCDiscovery> {
    const response = await fetch(
      `${this.config.issuer}/.well-known/openid-configuration`,
    );
    if (!response.ok) {
      throw new Error(`OIDC discovery failed: ${response.statusText}`);
    }
    return response.json();
  }

  private async startAuthorizationFlow(
    discovery: OIDCDiscovery,
    scopes: readonly string[],
  ): Promise<{ code: string; codeVerifier: string }> {
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);

    const state = crypto.randomUUID();
    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set("client_id", this.config.clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scopes.join(" "));
    authUrl.searchParams.set(
      "redirect_uri",
      "vscode://vercel.vscode-ai-gateway/auth/callback",
    );
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    const opened = await vscode.env.openExternal(
      vscode.Uri.parse(authUrl.toString()),
    );
    if (!opened) {
      throw new Error("Failed to open browser for authentication");
    }

    const code = await this.waitForCallback(state);
    return { code, codeVerifier };
  }

  private async exchangeCode(
    discovery: OIDCDiscovery,
    code: string,
    codeVerifier: string,
  ): Promise<TokenResponse> {
    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.config.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: "vscode://vercel.vscode-ai-gateway/auth/callback",
      }),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.statusText}`);
    }

    return response.json();
  }

  private generateCodeVerifier(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Buffer.from(array).toString("base64url");
  }

  private async generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Buffer.from(hash).toString("base64url");
  }

  private waitForCallback(expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        disposable.dispose();
        reject(new Error("Authentication timeout"));
      }, 300000);

      const disposable = vscode.window.registerUriHandler({
        handleUri(uri: vscode.Uri) {
          if (uri.path === "/auth/callback") {
            const params = new URLSearchParams(uri.query);
            const state = params.get("state");
            const code = params.get("code");
            const error = params.get("error");

            clearTimeout(timeout);
            disposable.dispose();

            if (error) {
              reject(new Error(`Authentication error: ${error}`));
            } else if (state !== expectedState) {
              reject(new Error("State mismatch"));
            } else if (code) {
              resolve(code);
            } else {
              reject(new Error("No authorization code received"));
            }
          }
        },
      });
    });
  }
}

interface OIDCDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  sub?: string;
  email?: string;
  name?: string;
}
```

## Drawbacks

1. **OIDC complexity**: Security-sensitive code requires careful review.
2. **Multiple auth paths**: More testing required for each provider.

## Alternatives

### Alternative 1: API Key Only

**Rejected because:** Enterprise users require OIDC integration.

## Unresolved Questions

1. **OIDC providers**: Which identity providers should we test with?
2. **Auth UX**: Should we add a dedicated settings UI for authentication?

## Implementation Plan

1. Implement API key and OIDC auth provider selection.
2. Test with common enterprise identity providers.
3. Add documentation for authentication flows.
