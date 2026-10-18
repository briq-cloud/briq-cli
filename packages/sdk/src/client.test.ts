import { describe, expect, it } from 'vitest';
import { Briq, BriqApiError } from './index.js';

function fakeFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
): typeof fetch {
  return async (input, init) => {
    const { status, body } = handler(String(input), init ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('Briq client', () => {
  it('sends the bearer key, encodes queries, parses results', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = new Briq('bq_live_x', {
      baseUrl: 'http://api.test/',
      fetch: fakeFetch((url, init) => {
        calls.push({ url, init });
        return { status: 200, body: { briqs: [], costLine: 'c' } };
      }),
    });
    await c.list({ stack: 'a b', all: true });
    expect(calls[0]?.url).toBe('http://api.test/v1/briqs?stack=a%20b&all=true');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer bq_live_x',
    );
  });
  it('keeps an id one path segment, whatever it contains', async () => {
    const urls: string[] = [];
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: fakeFetch((url) => {
        urls.push(url);
        return { status: 200, body: {} };
      }),
    });
    await c.status('../keys');
    await c.destroy('../stacks/st_x');
    await c.stop('../stacks/x/fork?');
    await c.forkStack('a/../b');
    expect(urls).toEqual([
      'http://api.test/v1/briqs/..%2Fkeys',
      'http://api.test/v1/briqs/..%2Fstacks%2Fst_x',
      'http://api.test/v1/briqs/..%2Fstacks%2Fx%2Ffork%3F/stop',
      'http://api.test/v1/stacks/a%2F..%2Fb/fork',
    ]);
  });
  it('brings a stack up from its file', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: fakeFetch((url, init) => {
        calls.push({ url, init });
        return { status: 200, body: { stack: 'app', created: [], drift: [], extra: [] } };
      }),
    });
    const r = await c.up({ file: 'stack: app', secrets: { K: 'v' }, wait: false });
    expect(r.stack).toBe('app');
    expect(calls[0]?.url).toBe('http://api.test/v1/stacks/up');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      file: 'stack: app',
      secrets: { K: 'v' },
      wait: false,
    });
  });
  it('throws typed errors', async () => {
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: fakeFetch(() => ({
        status: 402,
        body: { error: { code: 'quota_exceeded', message: 'cap' } },
      })),
    });
    await expect(c.run({ recipe: 'postgres' })).rejects.toMatchObject({
      status: 402,
      code: 'quota_exceeded',
      message: 'cap',
    });
    await expect(c.run({ recipe: 'postgres' })).rejects.toBeInstanceOf(BriqApiError);
  });
  it('forks a briq and a stack', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: fakeFetch((url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return {
          status: 201,
          body: { briqs: [], copied: {}, outputs: {}, stack: 's', skipped: [] },
        };
      }),
    });
    await c.fork('bq_1', { name: 'db-try' });
    await c.forkStack('default', { into: 'try' });
    await c.forkStack('main', { into: 'feat-x', expose: 'private' });
    expect(calls).toEqual([
      { url: 'http://api.test/v1/briqs/bq_1/fork', body: { name: 'db-try' } },
      { url: 'http://api.test/v1/stacks/default/fork', body: { into: 'try' } },
      { url: 'http://api.test/v1/stacks/main/fork', body: { into: 'feat-x', expose: 'private' } },
    ]);
  });
});

describe('stacks', () => {
  it('destroys a stack, its name one path segment', async () => {
    const calls: string[] = [];
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: fakeFetch((url, init) => {
        calls.push(`${init.method} ${url}`);
        return { status: 200, body: { stack: {}, briqs: [] } };
      }),
    });
    await c.destroyStack('feat-login');
    await c.destroyStack('a/b');
    expect(calls).toEqual([
      'DELETE http://api.test/v1/stacks/feat-login',
      'DELETE http://api.test/v1/stacks/a%2Fb',
    ]);
  });
});

describe('errors name their request', () => {
  it('carries the request id of a failed call', async () => {
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: async () =>
        new Response(JSON.stringify({ error: { code: 'internal', message: 'internal error' } }), {
          status: 500,
          headers: { 'x-request-id': 'req_abc' },
        }),
    });
    await expect(c.list()).rejects.toMatchObject({ status: 500, requestId: 'req_abc' });
  });
  it('turns an answer that is not JSON into an API error, not a parse error', async () => {
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    });
    const err = await c.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BriqApiError);
    expect(err).toMatchObject({ status: 502, code: 'error', message: 'HTTP 502' });
  });
});
