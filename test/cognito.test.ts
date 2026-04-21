import { describe, expect, it } from 'vitest';
import { CognitoExchanger } from '../src/auth/cognito.js';

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(payload)}.signature`;
}

describe('CognitoExchanger.decodeClaims', () => {
  const ex = new CognitoExchanger({
    userManagementBaseUrl: 'https://admin.nelson.management',
  });

  it('decodes a well-formed JWT', () => {
    const jwt = makeJwt({
      exp: 1_700_000_000,
      sub: 'abc',
      tenantids: ['acme', 'beta'],
      roles: ['CLIENT_ADMIN'],
      hotelids: '42',
      'cognito:username': 'sandeep',
    });
    const claims = ex.decodeClaims(jwt);
    expect(claims.exp).toBe(1_700_000_000);
    expect(claims.sub).toBe('abc');
    expect(claims.tenantids).toEqual(['acme', 'beta']);
    expect(claims.hotelids).toBe('42');
    expect(claims['cognito:username']).toBe('sandeep');
  });

  it('rejects malformed tokens', () => {
    expect(() => ex.decodeClaims('not-a-jwt')).toThrow();
    expect(() => ex.decodeClaims('only.two')).toThrow();
  });

  it('tolerates missing optional claims', () => {
    const jwt = makeJwt({ exp: 1, sub: 'x' });
    const claims = ex.decodeClaims(jwt);
    expect(claims.exp).toBe(1);
    expect(claims.tenantids).toBeUndefined();
  });
});
