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
  it('keeps a terminal bearer in headers and the briq in one encoded API path segment', () => {
    const client = new Briq('client-secret', { baseUrl: 'https://api.test/' });
    const handshake = client.shellHandshake('bq_one/../other?token=x', {
      cols: 120,
      rows: 40,
      term: 'xterm',
    });
    const url = new URL(handshake.url);
    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('api.test');
    expect(url.pathname).toBe('/v1/briqs/bq_one%2F..%2Fother%3Ftoken%3Dx/shell');
    expect(url.searchParams.get('cols')).toBe('120');
    expect(handshake.url).not.toContain('client-secret');
    expect(handshake.headers).toEqual({ authorization: 'Bearer client-secret' });
    expect(new Briq('key', { baseUrl: 'http://localhost:3001' }).shellHandshake('bq_one').url).toBe(
      'ws://localhost:3001/v1/briqs/bq_one/shell',
    );
  });

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
  it('sends a file as raw bytes and reads it back, and reads a refusal as any other', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: async (input, init) => {
        seen.push({ url: String(input), init: init ?? {} });
        if (init?.method === 'PUT' && String(input).includes('path=%2Fbig'))
          return new Response(
            JSON.stringify({ error: { code: 'validation', message: 'file too large (max 1 MB)' } }),
            { status: 400, headers: { 'x-request-id': 'req_1' } },
          );
        if (init?.method === 'PUT')
          return new Response(
            JSON.stringify({ path: '/a b', bytes: 3, sha256: 'x', verified: true }),
          );
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    const put = await c.putFileBytes('bq_1', '/a b', new Uint8Array([1, 2, 3]));
    expect(put.bytes).toBe(3);
    expect(seen[0]?.url).toBe('http://api.test/v1/briqs/bq_1/files?path=%2Fa+b');
    expect((seen[0]?.init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream',
    );
    // A stream is sent as it is read.
    await c.putFileBytes('bq_1', '/a b', new Blob(['x']).stream());
    expect((seen[1]?.init as { duplex?: string }).duplex).toBe('half');
    expect(await c.getFileBytes('bq_1', '/a b')).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen[2]?.url).toBe('http://api.test/v1/briqs/bq_1/files/raw?path=%2Fa+b');
    const err = await c.putFileBytes('bq_1', '/big', new Uint8Array(1)).catch((e) => e);
    expect(err).toBeInstanceOf(BriqApiError);
    expect(err).toMatchObject({ status: 400, code: 'validation', requestId: 'req_1' });
  });
});

describe('creating calls', () => {
  const ok = () =>
    new Response(JSON.stringify({ briqs: [], outputs: {}, recipe: null, costLine: '' }), {
      status: 201,
    });
  const headersOf = (init: RequestInit | undefined) => new Headers(init?.headers);

  it('send an Idempotency-Key, a new one for each call', async () => {
    const keys: Array<string | null> = [];
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: async (_url, init) => {
        keys.push(headersOf(init).get('idempotency-key'));
        return ok();
      },
    });
    await c.run({ recipe: 'redis' });
    await c.run({ recipe: 'redis' });
    await c.up({ file: 'services: {}' });
    expect(keys.every((k) => k && k.length >= 16)).toBe(true);
    expect(new Set(keys).size).toBe(3);
  });

  it('send the key given, and none on other calls', async () => {
    const seen: Array<string | null> = [];
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      fetch: async (_url, init) => {
        seen.push(headersOf(init).get('idempotency-key'));
        return ok();
      },
    });
    await c.run({ recipe: 'redis' }, { idempotencyKey: 'mine' });
    await c.exec('bq_1', ['ls']);
    expect(seen).toEqual(['mine', null]);
  });

  it('retry with the same key when no answer came or the API was unavailable', async () => {
    const keys: Array<string | null> = [];
    let n = 0;
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      retryPauseMs: 1,
      fetch: async (_url, init) => {
        keys.push(headersOf(init).get('idempotency-key'));
        n++;
        if (n === 1) throw new TypeError('fetch failed');
        if (n === 2)
          return new Response(JSON.stringify({ error: { code: 'provider_error', message: 'x' } }), {
            status: 503,
          });
        return ok();
      },
    });
    await expect(c.run({ recipe: 'redis' })).resolves.toMatchObject({ recipe: null });
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('give up after three attempts, and do not retry a refusal', async () => {
    let n = 0;
    const down = new Briq('k', {
      baseUrl: 'http://api.test',
      retryPauseMs: 1,
      fetch: async () => {
        n++;
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.run({ recipe: 'redis' })).rejects.toThrow('fetch failed');
    expect(n).toBe(3);

    n = 0;
    const refused = new Briq('k', {
      baseUrl: 'http://api.test',
      retryPauseMs: 1,
      fetch: async () => {
        n++;
        return new Response(JSON.stringify({ error: { code: 'payment_required', message: 'x' } }), {
          status: 402,
        });
      },
    });
    await expect(refused.run({ recipe: 'redis' })).rejects.toMatchObject({ status: 402 });
    expect(n).toBe(1);
  });

  const fail = (status: number, code: string, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ error: { code, message: 'x' } }), { status, headers });

  /** Runs `run` against answers given in order; returns how many calls were made. */
  async function attempts(answers: Array<() => Response>, key?: string) {
    let n = 0;
    const keys = new Set<string | null>();
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      retryPauseMs: 1,
      fetch: async (_url, init) => {
        keys.add(headersOf(init).get('idempotency-key'));
        const answer = answers[Math.min(n, answers.length - 1)] as () => Response;
        n++;
        return answer();
      },
    });
    const result = await c.run({ recipe: 'redis' }, key ? { idempotencyKey: key } : undefined).then(
      () => 'ok',
      (e: unknown) => e,
    );
    return { n, keys, result };
  }

  it('retry while the first request with the key is still running', async () => {
    const r = await attempts([() => fail(409, 'idempotency_in_progress'), ok]);
    expect(r.n).toBe(2);
    expect(r.result).toBe('ok');
  });

  it('retry a 502 or 504 from a proxy', async () => {
    expect((await attempts([() => fail(502, 'error'), ok])).n).toBe(2);
    expect((await attempts([() => fail(504, 'error'), ok])).n).toBe(2);
  });

  it('do not retry a 502 provider_error', async () => {
    const r = await attempts([() => fail(502, 'provider_error')]);
    expect(r.n).toBe(1);
    expect(r.result).toMatchObject({ status: 502, code: 'provider_error' });
  });

  it('do not send again an answer that is a stored one', async () => {
    const r = await attempts([
      () => fail(503, 'provider_error', { 'idempotent-replayed': 'true' }),
    ]);
    expect(r.n).toBe(1);
    expect(r.result).toMatchObject({ status: 503, replayed: true });
  });

  it('keep the caller key across retries', async () => {
    const r = await attempts([() => fail(504, 'error'), ok], 'mine');
    expect([...r.keys]).toEqual(['mine']);
  });

  it('never retry or key exec, expose and other POSTs', async () => {
    let n = 0;
    const keys: Array<string | null> = [];
    const c = new Briq('k', {
      baseUrl: 'http://api.test',
      retryPauseMs: 1,
      fetch: async (_url, init) => {
        n++;
        keys.push(headersOf(init).get('idempotency-key'));
        return fail(503, 'provider_error');
      },
    });
    await expect(c.exec('bq_1', ['ls'])).rejects.toMatchObject({ status: 503 });
    await expect(c.expose('bq_1', { port: 80 })).rejects.toMatchObject({ status: 503 });
    expect(n).toBe(2);
    expect(keys).toEqual([null, null]);
  });
});
