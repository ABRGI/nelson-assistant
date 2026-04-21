import { request } from 'undici';
import { z } from 'zod';
import { logger } from '../observability/logger.js';

export interface IssuedTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  nelsonSub: string;
}

export interface NelsonAuthConfig {
  userManagementBaseUrl: string;
}

export class NelsonLoginFailed extends Error {
  constructor(message = 'Login failed') {
    super(message);
    this.name = 'NelsonLoginFailed';
  }
}

export class RefreshTokenInvalid extends Error {
  constructor(message = 'Nelson refresh token is no longer valid') {
    super(message);
    this.name = 'RefreshTokenInvalid';
  }
}

const NelsonLoginResponseSchema = z.object({
  message: z.string().optional(),
  token: z.string().min(1),
  refreshtoken: z.string().min(1),
  accesstoken: z.string().optional(),
  challenge: z.unknown().optional(),
  session: z.unknown().optional(),
});

const ClaimsSchema = z.object({
  exp: z.number(),
  sub: z.string(),
  tenantids: z.union([z.array(z.string()), z.string()]).optional(),
  roles: z.union([z.array(z.string()), z.string()]).optional(),
  hotelids: z.union([z.array(z.string()), z.string()]).optional(),
  environmentids: z.union([z.array(z.string()), z.string()]).optional(),
  'cognito:username': z.string().optional(),
});
export type JwtClaims = z.infer<typeof ClaimsSchema>;

export class CognitoExchanger {
  private readonly cache = new Map<string, IssuedTokens>();

  constructor(private readonly config: NelsonAuthConfig) {}

  /**
   * Password login via user-management-service. Same endpoint the Nelson
   * management UI uses. One Cognito pool serves every tenant, so no per-tenant
   * credentials.
   */
  async loginViaNelsonApi(username: string, password: string): Promise<IssuedTokens> {
    return this.callLogin({ username, password, returnaccesstoken: true });
  }

  /**
   * Refresh-token exchange goes through the same /api/user/login endpoint:
   * the Lambda branches to REFRESH_TOKEN flow when `refreshtoken` is present.
   * `username` must be the Cognito SUB (captured at login time), not the email.
   */
  async exchangeRefresh(
    slackUserId: string,
    nelsonSub: string,
    refreshToken: string,
  ): Promise<IssuedTokens> {
    const cached = this.cache.get(slackUserId);
    if (cached && cached.expiresAt - Date.now() > 60_000) return cached;

    const tokens = await this.callLogin({
      username: nelsonSub,
      refreshtoken: refreshToken,
      returnaccesstoken: false,
    });
    // The refresh branch echoes the input refresh token if Cognito didn't rotate it.
    this.cache.set(slackUserId, tokens);
    return tokens;
  }

  invalidateCache(slackUserId: string): void {
    this.cache.delete(slackUserId);
  }

  decodeClaims(idToken: string): JwtClaims {
    const parts = idToken.split('.');
    if (parts.length !== 3 || !parts[1]) {
      throw new Error('not a valid JWT');
    }
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return ClaimsSchema.parse(JSON.parse(payload));
  }

  private async callLogin(body: {
    username: string;
    password?: string;
    refreshtoken?: string;
    returnaccesstoken: boolean;
  }): Promise<IssuedTokens> {
    const url = `${this.config.userManagementBaseUrl.replace(/\/$/, '')}/api/user/login`;
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const bodyText = await res.body.text();
    if (res.statusCode === 401) {
      if (body.refreshtoken) throw new RefreshTokenInvalid();
      throw new NelsonLoginFailed();
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      logger.warn(
        { status: res.statusCode, bodyPreview: bodyText.slice(0, 200) },
        'nelson /api/user/login returned non-2xx',
      );
      throw new Error(`Nelson login failed (${res.statusCode})`);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(bodyText);
    } catch {
      throw new Error('Nelson login response was not JSON');
    }
    const parsed = NelsonLoginResponseSchema.parse(parsedJson);
    const claims = this.decodeClaims(parsed.token);
    return {
      idToken: parsed.token,
      accessToken: parsed.accesstoken ?? '',
      refreshToken: parsed.refreshtoken,
      expiresAt: claims.exp * 1000,
      nelsonSub: claims.sub,
    };
  }
}
