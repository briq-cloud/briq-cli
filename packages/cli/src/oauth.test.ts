import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { type AuthServer, discover, pollForTokens, refreshTokens } from './oauth.js';

/** A fetch that answers from a list, recording what it was asked. */
function scripted(answers: Array<[number, Record<string, unknown>, Record<string, string>?]>) {
  const calls: Array<{ url: string; body: string }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    const [status, body, headers] = answers.shift() ?? [500, {}];
    return new Response(JSON.stringify(body), { status, headers: headers ?? {} });
  }) as typeof fetch;
  return { f, calls };
}

const AS: AuthServer = {
  issuer: 'https://app.briq.test/api/auth',
  resource: 'https://api.briq.test/mcp',
  deviceEndpoint: 'https://app.briq.test/api/auth/device/code',
  tokenEndpoint: 'https://app.briq.test/api/auth/oauth2/token',
  registrationEndpoint: 'https://app.briq.test/api/auth/oauth2/register',
};
const CODE = { deviceCode: 'dc', userCode: 'ABCDEFGH', link: 'x', interval: 5, expiresIn: 900 };

function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

describe('device flow', () => {
  it('finds the authorization server from the API, well-known paths after the origin', async () => {
    const { f, calls } = scripted([
      [200, { resource: AS.resource, authorization_servers: [AS.issuer] }],
      [
        200,
        {
          issuer: AS.issuer,
          device_authorization_endpoint: AS.deviceEndpoint,
          token_endpoint: AS.tokenEndpoint,
          registration_endpoint: AS.registrationEndpoint,
        },
      ],
    ]);
    expect(await discover('https://api.briq.test', f)).toEqual(AS);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.briq.test/.well-known/oauth-protected-resource/mcp',
      'https://app.briq.test/.well-known/oauth-authorization-server/api/auth',
    ]);
  });

  it('waits while pending, slows down when told, and returns the tokens', async () => {
    const c = clock();
    const { f, calls } = scripted([
      [400, { error: 'authorization_pending' }],
      [400, { error: 'slow_down' }],
      [429, {}, { 'retry-after': '20' }],
      [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }],
    ]);
    const t = await pollForTokens(AS, 'cid', CODE, f, c);
    expect(t).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: c.now() + 3_600_000 });
    expect(c.waits).toEqual([5000, 5000, 10_000, 20_000]);
    expect(new URLSearchParams(calls[0]?.body)).toEqual(
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: 'dc',
        client_id: 'cid',
        resource: AS.resource,
      }),
    );
  });

  it('stops on a refusal, an expired code, or the deadline, with the auth exit code', async () => {
    for (const [answer, text] of [
      [{ error: 'access_denied' }, 'refused'],
      [{ error: 'expired_token' }, 'expired'],
    ] as const) {
      const { f } = scripted([[400, answer]]);
      const err = await pollForTokens(AS, 'cid', CODE, f, clock()).catch((e) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(3);
      expect((err as Error).message).toContain(text);
    }
    const pending = scripted(
      Array.from(
        { length: 10 },
        () => [400, { error: 'authorization_pending' }] as [number, Record<string, unknown>],
      ),
    );
    const err = await pollForTokens(
      AS,
      'cid',
      { ...CODE, expiresIn: 12 },
      pending.f,
      clock(),
    ).catch((e) => e);
    expect((err as Error).message).toContain('expired');
    expect(pending.calls).toHaveLength(2);
  });

  it('keeps asking through a network drop, while the code is good', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      if (calls === 2) return new Response('{}', { status: 502 });
      return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
    }) as typeof fetch;
    expect((await pollForTokens(AS, 'cid', CODE, f, clock())).accessToken).toBe('at');
    expect(calls).toBe(3);
  });
});

describe('refresh', () => {
  const cred = {
    tokenEndpoint: AS.tokenEndpoint,
    clientId: 'cid',
    resource: AS.resource,
    refreshToken: 'rt1',
  };

  it('rotates both tokens, and keeps the refresh token when the server does not rotate', async () => {
    const now = () => 5_000;
    const rotated = scripted([
      [200, { access_token: 'at2', refresh_token: 'rt2', expires_in: 10 }],
    ]);
    expect(await refreshTokens(cred, rotated.f, now)).toEqual({
      accessToken: 'at2',
      refreshToken: 'rt2',
      expiresAt: 15_000,
    });
    expect(new URLSearchParams(rotated.calls[0]?.body).get('grant_type')).toBe('refresh_token');
    const kept = scripted([[200, { access_token: 'at3' }]]);
    expect(await refreshTokens(cred, kept.f, now)).toMatchObject({ refreshToken: 'rt1' });
  });

  it('a refused refresh is the end of the sign-in; a server error is not', async () => {
    const refused = await refreshTokens(
      cred,
      scripted([[400, { error: 'invalid_grant' }]]).f,
    ).catch((e) => e);
    expect((refused as CliError).exitCode).toBe(3);
    const down = await refreshTokens(cred, scripted([[503, {}]]).f).catch((e) => e);
    expect((down as CliError).exitCode).toBe(1);
    const none = await refreshTokens({ ...cred, refreshToken: null }, scripted([]).f).catch(
      (e) => e,
    );
    expect((none as CliError).exitCode).toBe(3);
  });
});
