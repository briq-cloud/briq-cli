import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runArgv } from './native-exec.js';
import { nativeSandbox } from './native-sandbox.js';
vi.mock('./native-exec.js', () => ({ runArgv: vi.fn() }));
const run = vi.mocked(runArgv);
beforeEach(() => {
  vi.useFakeTimers();
  run.mockReset().mockResolvedValue({ exitCode: 0, timedOut: false });
});
afterEach(() => vi.useRealTimers());
function fixture(state = 'running') {
  let row: Record<string, unknown>;
  const calls: Array<{ method: string; path: string; body: unknown; signal?: AbortSignal | null }> =
    [];
  let onCreate: (() => void) | undefined;
  let onStatus: (() => void) | undefined;
  const http = vi.fn<typeof fetch>(async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(String(url)).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, signal: init?.signal });
    if (path === '/v1/quota')
      return Response.json({
        features: { briqLabels: true },
        availableSizes: ['small'],
        team: { id: 'tm_owned' },
      });
    if (method === 'POST') {
      row = {
        ...body.spec,
        id: 'bq_owned',
        teamId: 'tm_owned',
        state,
        createdAt: '2026-11-02T00:00:00.000Z',
      };
      onCreate?.();
      return Response.json({ briqs: [row] });
    }
    if (method === 'DELETE') row.state = 'destroyed';
    else onStatus?.();
    return Response.json({ briq: row });
  });
  return {
    provider: nativeSandbox({ apiKey: 'fixture', baseUrl: 'https://api.test', fetch: http }),
    calls,
    http,
    created(fn: () => void) {
      onCreate = fn;
    },
    status(fn: () => void) {
      onStatus = fn;
    },
    running() {
      row.state = 'running';
    },
  };
}
it('asks for bounded server wait and executes readiness without a status GET when running', async () => {
  const f = fixture();
  await f.provider.create({ labels: {} });
  expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/quota', 'POST /v1/briqs']);
  expect(f.calls[1].body).toMatchObject({ wait: true, waitTimeoutMs: 25000 });
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][3].cmd[0]).toBe('python3');
});
it('with eagerChecks false create is the POST alone: no quota read, no readiness exec', async () => {
  const f = fixture();
  const lean = nativeSandbox({
    apiKey: 'fixture',
    baseUrl: 'https://api.test',
    fetch: f.http,
    eagerChecks: false,
  });
  const created = await lean.create({ labels: {} });
  expect(created.id).toBe('bq_owned');
  expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/briqs']);
  expect(run).not.toHaveBeenCalled();
});
it('creates at the configured size and refuses it when the quota does not offer it', async () => {
  const f = fixture();
  const lean = nativeSandbox({
    apiKey: 'fixture',
    baseUrl: 'https://api.test',
    fetch: f.http,
    eagerChecks: false,
    size: 'nano',
  });
  await lean.create({ labels: {} });
  expect(f.calls[0].body).toMatchObject({ spec: { size: 'nano' } });
  const eager = nativeSandbox({
    apiKey: 'fixture',
    baseUrl: 'https://api.test',
    fetch: f.http,
    size: 'nano',
  });
  await expect(eager.create({ labels: {} })).rejects.toMatchObject({ code: 'unsupported' });
});
it.each(['small', 'medium', 'large', 'xlarge'] as const)(
  'creates one sandbox at size %s',
  async (size) => {
    const f = fixture();
    const lean = nativeSandbox({
      apiKey: 'fixture',
      baseUrl: 'https://api.test',
      fetch: f.http,
      eagerChecks: false,
    });
    await lean.create({ labels: {}, size });
    expect(f.calls[0].body).toMatchObject({ spec: { size } });
  },
);
it('refuses a valid size the quota does not offer', async () => {
  const f = fixture();
  await expect(f.provider.create({ labels: {}, size: 'medium' })).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/quota']);
});
it.each(['xs', '2xl', 'nano', '', 'unknown', 3])(
  'refuses size %j as unsupported before any request',
  async (size) => {
    const f = fixture();
    await expect(f.provider.create({ labels: {}, size: size as never })).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(f.calls).toHaveLength(0);
  },
);
it('with eagerChecks false still reads quota when literal environment secrets are sent', async () => {
  const f = fixture();
  const lean = nativeSandbox({
    apiKey: 'fixture',
    baseUrl: 'https://api.test',
    fetch: f.http,
    eagerChecks: false,
  });
  await expect(lean.create({ labels: {}, env: { TOKEN: 'x' } })).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/quota']);
});
it.each(['creating', 'starting'])(
  'uses one POST and paced same-ID fallback for %s',
  async (state) => {
    const f = fixture(state);
    f.status(() => f.running());
    const pending = f.provider.create({ labels: {} });
    await vi.advanceTimersByTimeAsync(499);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/quota',
      'POST /v1/briqs',
      'GET /v1/briqs/bq_owned',
    ]);
  },
);
it('shares the boot budget with the create response and cleans up at its deadline', async () => {
  const f = fixture('creating');
  // Account for server wait without adding a new 75-second client budget.
  f.created(() => vi.setSystemTime(Date.now() + 25000));
  const pending = f.provider.create({ labels: {} });
  const result = expect(pending).rejects.toMatchObject({ code: 'timeout' });
  await vi.advanceTimersByTimeAsync(50000);
  await result;
  expect(f.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  expect(f.calls.filter((c) => c.method === 'GET' && c.path.endsWith('bq_owned'))).toHaveLength(99);
  expect(f.calls.at(-1)?.method).toBe('DELETE');
  expect(run).not.toHaveBeenCalled();
});
it('cancels a known pending instance and confirms owned cleanup without replay', async () => {
  const f = fixture('creating');
  const controller = new AbortController();
  const pending = f.provider.create({ labels: {}, signal: controller.signal });
  const result = expect(pending).rejects.toMatchObject({ code: 'aborted' });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await result;
  expect(f.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE']);
});
it('cancels an in-flight fallback GET with the boot signal and still cleans up', async () => {
  const f = fixture('creating');
  const controller = new AbortController();
  const original = f.http.getMockImplementation()!;
  f.http.mockImplementation(async (url, init) => {
    if (init?.method === 'GET' && String(url).endsWith('/bq_owned'))
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    return original(url, init);
  });
  const pending = f.provider.create({ labels: {}, signal: controller.signal });
  const result = expect(pending).rejects.toMatchObject({ code: 'aborted' });
  await vi.advanceTimersByTimeAsync(500);
  controller.abort();
  await result;
  expect(f.calls.at(-1)?.method).toBe('DELETE');
});
const posts = (f: ReturnType<typeof fixture>) =>
  f.http.mock.calls.filter(([, init]) => init?.method === 'POST');
it.each(['abort', 'invalid'])(
  'keeps an ambiguous %s create outcome unknown with no replay or speculative delete',
  async (mode) => {
    const f = fixture();
    const original = f.http.getMockImplementation()!;
    const controller = new AbortController();
    f.http.mockImplementation(async (url, init) => {
      if (init?.method !== 'POST') return original(url, init);
      if (mode === 'abort') {
        controller.abort();
        throw new Error('connection lost');
      }
      return Response.json({ briqs: [{ id: 'bq_other' }] });
    });
    await expect(
      f.provider.create({ labels: {}, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(posts(f)).toHaveLength(1);
    expect(f.http.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  },
);
it.each(['lost', 'server'])(
  'asks again with the same key after %s answers, then reports an unknown outcome',
  async (mode) => {
    const f = fixture();
    const original = f.http.getMockImplementation()!;
    f.http.mockImplementation(async (url, init) => {
      if (init?.method !== 'POST') return original(url, init);
      if (mode === 'server') return Response.json({}, { status: 503 });
      throw new Error('connection lost');
    });
    const pending = expect(f.provider.create({ labels: {} })).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    const sent = posts(f);
    expect(sent).toHaveLength(3);
    const keys = sent.map(
      ([, init]) => (init?.headers as Record<string, string>)['idempotency-key'],
    );
    expect(new Set(keys).size).toBe(1);
    expect(new Set(sent.map(([, init]) => init?.body)).size).toBe(1);
    expect(f.http.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
  },
);
it('creates the sandbox when a dropped connection is followed by an answer', async () => {
  const f = fixture();
  const original = f.http.getMockImplementation()!;
  let dropped = 0;
  f.http.mockImplementation(async (url, init) => {
    if (init?.method === 'POST' && dropped++ < 2) throw new Error('connection lost');
    return original(url, init);
  });
  const pending = f.provider.create({ labels: {} });
  await vi.advanceTimersByTimeAsync(2000);
  await expect(pending).resolves.toBeDefined();
  expect(posts(f)).toHaveLength(3);
});
it.each([
  ['a replayed server error', { status: 503, headers: { 'idempotent-replayed': 'true' } }],
  ['a provider error', { status: 502 }, 'provider_error'],
  ['a refusal', { status: 402 }, 'quota_exceeded'],
])('does not ask again after %s', async (_name, init, code) => {
  const f = fixture();
  const original = f.http.getMockImplementation()!;
  f.http.mockImplementation(async (url, i) =>
    i?.method === 'POST'
      ? Response.json({ error: { code: code ?? 'internal' } }, init)
      : original(url, i),
  );
  await expect(f.provider.create({ labels: {} })).rejects.toBeDefined();
  expect(posts(f)).toHaveLength(1);
});
it('asks again while the first request with the key is still running', async () => {
  const f = fixture();
  const original = f.http.getMockImplementation()!;
  let n = 0;
  f.http.mockImplementation(async (url, init) =>
    init?.method === 'POST' && n++ === 0
      ? Response.json({ error: { code: 'idempotency_in_progress' } }, { status: 409 })
      : original(url, init),
  );
  const pending = f.provider.create({ labels: {} });
  await vi.advanceTimersByTimeAsync(1000);
  await expect(pending).resolves.toBeDefined();
  expect(posts(f)).toHaveLength(2);
});
it('reports unknown when owned cleanup cannot be confirmed', async () => {
  const f = fixture('stopped');
  const original = f.http.getMockImplementation()!;
  f.http.mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') throw new Error('lost cleanup');
    return original(url, init);
  });
  await expect(f.provider.create({ labels: {} })).rejects.toMatchObject({
    code: 'outcome_unknown',
  });
  expect(f.calls.filter((c) => c.path.endsWith('/bq_owned'))).toHaveLength(0);
});
it('cleans up when readiness fails and keeps unacknowledged exec outcomes unknown', async () => {
  for (const error of [undefined, { code: 'outcome_unknown' }]) {
    const f = fixture();
    if (error) {
      const { BriqOperationError } = await import('./native-errors.js');
      run.mockRejectedValueOnce(new BriqOperationError('outcome_unknown', 'lost ack'));
    } else run.mockResolvedValueOnce({ exitCode: 1, timedOut: false });
    await expect(f.provider.create({ labels: {} })).rejects.toMatchObject({
      code: error?.code ?? 'unsupported',
    });
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  }
});
it('rejects a pre-aborted create before even reading quota', async () => {
  const f = fixture();
  await expect(
    f.provider.create({ labels: {}, signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ code: 'aborted' });
  expect(f.http).not.toHaveBeenCalled();
});
it('includes readiness in the boot budget and gives cleanup an independent signal', async () => {
  const f = fixture();
  run.mockImplementationOnce(async (_base, _key, _id, input) => {
    expect(input.timeoutMs).toBe(30000);
    vi.setSystemTime(Date.now() + 75000);
    return { exitCode: 0, timedOut: false };
  });
  await expect(f.provider.create({ labels: {} })).rejects.toMatchObject({ code: 'timeout' });
  expect(f.calls.at(-1)?.method).toBe('DELETE');
  expect(f.calls.at(-1)?.signal?.aborted).toBe(false);
});
it.each(['error', 'stopped', 'destroyed', 'moving'])(
  'does not poll a non-boot state %s',
  async (state) => {
    const f = fixture(state);
    await expect(f.provider.create({ labels: {} })).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE']);
    expect(run).not.toHaveBeenCalled();
  },
);
/* Routing of a command: plain HTTP when nothing needs the stream, the WebSocket otherwise. */
async function execFixture(answer: () => Response | Promise<Response> = () => answerOf()) {
  const f = fixture();
  const original = f.http.getMockImplementation()!;
  const posts: Array<{ path: string; body: Record<string, unknown>; auth: string | null }> = [];
  f.http.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST' && path.endsWith('/exec')) {
      posts.push({
        path,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get('authorization'),
      });
      return answer();
    }
    return original(url, init);
  });
  await f.provider.create({ labels: {} });
  run.mockClear();
  return { ...f, posts };
}
function answerOf(over: Record<string, unknown> = {}, status = 200, headers = {}) {
  return Response.json(
    { stdout: 'v22.0.0\n', stderr: '', exitCode: 0, timedOut: false, costLine: 'x', ...over },
    { status, headers },
  );
}
const collect = () => {
  const chunks: Array<{ stream: string; text: string }> = [];
  return { chunks, onChunk: (c: { stream: string; text: string }) => void chunks.push(c) };
};
const base = { cmd: ['node', '-v'], cwd: '/workspace', env: {}, timeoutMs: 30000 } as const;
it('runs a collecting command as one POST /exec on the shared client, result in the stream shape', async () => {
  const f = await execFixture();
  const c = collect();
  const out = await f.provider.run('bq_owned', { ...base, live: false, onChunk: c.onChunk });
  expect(out).toEqual({ exitCode: 0, timedOut: false });
  expect(c.chunks).toEqual([{ stream: 'stdout', text: 'v22.0.0\n' }]);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0].path).toBe('/v1/briqs/bq_owned/exec');
  expect(f.posts[0].auth).toBe('Bearer fixture');
  expect(f.posts[0].body).toMatchObject({
    cmd: [
      '/bin/sh',
      '-c',
      expect.stringContaining('cd "$1"'),
      'briq-cwd',
      '/workspace',
      'node',
      '-v',
    ],
    timeoutMs: 30000,
  });
  expect(f.posts[0].body).not.toHaveProperty('async');
  expect(run.mock.calls.filter((c) => c[3].cmd[0] === 'node')).toHaveLength(0);
});
it('sends stdin and environment in the body', async () => {
  const f = await execFixture();
  await f.provider.run('bq_owned', {
    ...base,
    env: { A: 'b' },
    stdin: 'in',
    live: false,
    onChunk: () => {},
  });
  expect(f.posts[0].body).toMatchObject({ stdin: 'in', env: { A: 'b' } });
});
it.each([
  ['a streaming caller (exec keeps its contract)', { live: true }],
  ['no live flag', {}],
  ['a signal', { live: false, signal: new AbortController().signal }],
  ['a timeout over the route limit', { live: false, timeoutMs: 60001 }],
  ['a timeout under the route minimum', { live: false, timeoutMs: 999 }],
  ['a variable name the route refuses', { live: false, env: { 'A-B': '1' } }],
  [
    'an environment over the route limit',
    { live: false, env: { A: 'x'.repeat(17000), B: 'x'.repeat(17000) } },
  ],
  ['a long command line', { live: false, cmd: ['echo', 'x'.repeat(9000)] }],
])('stays on the WebSocket for %s', async (_name, over) => {
  const f = await execFixture();
  await f.provider.run('bq_owned', { ...base, onChunk: () => {}, ...over } as never);
  expect(f.posts).toHaveLength(0);
  expect(run.mock.calls.filter((c) => c[3].cmd[0] !== 'python3')).toHaveLength(1);
});
it('provider.exec streams over the WebSocket', async () => {
  const f = await execFixture();
  await f.provider.exec('bq_owned', {
    command: 'node -v',
    cwd: '/workspace',
    env: {},
    timeoutMs: 1000,
    onChunk: () => {},
  });
  expect(f.posts).toHaveLength(0);
  expect(run).toHaveBeenCalledTimes(1);
});
it('refuses a command over the stream bounds before any request', async () => {
  const f = await execFixture();
  await expect(
    f.provider.run('bq_owned', { ...base, cwd: 'relative', live: false, onChunk: () => {} }),
  ).rejects.toMatchObject({ code: 'invalid_argument' });
  expect(f.posts).toHaveLength(0);
});
it.each([
  [{ stdout: '', stderr: 'bash: x: command not found\n', exitCode: 127 }, 127],
  [{ stdout: '', stderr: 'cannot execute\n', exitCode: 126 }, 126],
  [{ stdout: 'a', stderr: 'b', exitCode: 3 }, 3],
])('reports the exit code %#', async (answer, code) => {
  const f = await execFixture(() => answerOf(answer));
  const c = collect();
  const out = await f.provider.run('bq_owned', { ...base, live: false, onChunk: c.onChunk });
  expect(out).toEqual({ exitCode: code, timedOut: false });
  expect(c.chunks.map((x) => x.stream)).toEqual(answer.stdout ? ['stdout', 'stderr'] : ['stderr']);
});
it('reports a timeout as no exit code, like the stream', async () => {
  const f = await execFixture(() =>
    answerOf({ exitCode: 124, timedOut: true, stderr: 'too slow' }),
  );
  const c = collect();
  const out = await f.provider.run('bq_owned', { ...base, live: false, onChunk: c.onChunk });
  expect(out).toEqual({ exitCode: null, timedOut: true });
  expect(c.chunks).toContainEqual({ stream: 'stderr', text: 'too slow' });
});
it.each([
  [400, 'invalid_argument'],
  [401, 'auth'],
  [403, 'auth'],
  [404, 'not_found'],
  [402, 'quota'],
  [429, 'quota'],
  [409, 'unavailable'],
  [413, 'invalid_argument'],
])('maps a %i refusal like the stream does', async (status, code) => {
  const f = await execFixture(() =>
    Response.json({ error: { code: 'x', message: 'secret text' } }, { status }),
  );
  const failure = f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} });
  await expect(failure).rejects.toMatchObject({ code });
  await expect(failure).rejects.not.toThrow(/secret text/);
  expect(f.posts).toHaveLength(1);
});
it.each([500, 502, 504])(
  'a %i may follow a run command: unknown outcome with the request id, sent once',
  async (status) => {
    const f = await execFixture(() =>
      Response.json(
        { error: { message: 'internal detail' } },
        { status, headers: { 'x-request-id': 'req_abc123' } },
      ),
    );
    const failure = f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} });
    await expect(failure).rejects.toMatchObject({
      code: 'outcome_unknown',
      message: expect.stringContaining('req_abc123'),
    });
    await expect(failure).rejects.not.toThrow(/internal detail/);
    expect(f.posts).toHaveLength(1);
  },
);
it.each([
  ['the provider failed before the exec', { op: 'get machine' }, 'unavailable'],
  ['a tenant call failed before the exec', { op: 'list tenants' }, 'unavailable'],
  ['the provider did not answer the exec', { op: 'exec' }, 'outcome_unknown'],
  ['a 503 that is not ours', undefined, 'outcome_unknown'],
])('a 503 where %s is %s', async (_name, details, code) => {
  const f = await execFixture(() =>
    details
      ? Response.json({ error: { code: 'provider_error', message: 'x', details } }, { status: 503 })
      : new Response('<html>unavailable</html>', { status: 503 }),
  );
  await expect(
    f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} }),
  ).rejects.toMatchObject({ code });
  expect(f.posts).toHaveLength(1);
});
it.each([
  ['the machine was not running', 'machine not running', 'unavailable'],
  ['the briq was asleep', undefined, 'unavailable'],
  ['the host lost it mid-command', 'the machine went down during the command', 'outcome_unknown'],
  ['the connection dropped mid-command', 'exec request failed: EOF', 'outcome_unknown'],
])('a 409 where %s is %s', async (_name, providerSaid, code) => {
  const f = await execFixture(() =>
    Response.json(
      { error: { code: 'invalid_state', message: 'x', details: { providerSaid } } },
      { status: 409 },
    ),
  );
  await expect(
    f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} }),
  ).rejects.toMatchObject({ code });
  expect(f.posts).toHaveLength(1);
});
it('a 429 carries the wait the API asks, in the error and in its text', async () => {
  const f = await execFixture(() =>
    Response.json(
      { error: { code: 'quota_exceeded' } },
      { status: 429, headers: { 'retry-after': '17' } },
    ),
  );
  const failure = f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} });
  await expect(failure).rejects.toMatchObject({
    code: 'quota',
    retryAfterSeconds: 17,
    message: 'Briq command refused (quota); retry in 17s',
  });
});
it('output the provider cut at its limit is a quota failure, not a short success', async () => {
  const f = await execFixture(() => answerOf({ stdout: 'a'.repeat(100), truncated: true }));
  const c = collect();
  await expect(
    f.provider.run('bq_owned', { ...base, live: false, onChunk: c.onChunk }),
  ).rejects.toMatchObject({ code: 'quota' });
  expect(c.chunks).toEqual([]);
});
it('an answer from an API that does not say truncated is read as complete', async () => {
  const f = await execFixture();
  await expect(
    f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} }),
  ).resolves.toEqual({ exitCode: 0, timedOut: false });
});
it('an answer far beyond any output is a quota failure, read only up to its limit', async () => {
  const f = await execFixture(() => new Response(`{"stdout":"${'a'.repeat(33 * 1024 * 1024)}"}`));
  await expect(
    f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} }),
  ).rejects.toMatchObject({ code: 'quota' });
});
it.each([
  ['a connection that was never made', { cause: { code: 'ECONNREFUSED' } }, 'unavailable'],
  ['a socket closed under the request', { cause: { code: 'UND_ERR_SOCKET' } }, 'outcome_unknown'],
  ['a failure with no cause', {}, 'outcome_unknown'],
])('%s is %s, sent once', async (_name, shape, code) => {
  const f = await execFixture(() =>
    Promise.reject(Object.assign(new TypeError('fetch failed'), shape)),
  );
  await expect(
    f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} }),
  ).rejects.toMatchObject({ code });
  expect(f.posts).toHaveLength(1);
});
it('does not repeat a request id that is not shaped like ours', async () => {
  const f = await execFixture(() =>
    Response.json({}, { status: 500, headers: { 'x-request-id': 'a b<script>' } }),
  );
  await expect(
    f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} }),
  ).rejects.toMatchObject({ message: 'Briq command failed (outcome_unknown)' });
});
it.each(['lost', 'garbage', 'incomplete', 'range'])(
  'an unusable answer (%s) is an unknown outcome, never a retry',
  async (mode) => {
    const f = await execFixture(() =>
      mode === 'lost'
        ? Promise.reject(new Error('connection reset'))
        : mode === 'garbage'
          ? new Response('<html>bad gateway</html>')
          : mode === 'incomplete'
            ? Response.json({ stdout: 'x' })
            : answerOf({ exitCode: 300 }),
    );
    await expect(
      f.provider.run('bq_owned', { ...base, live: false, onChunk: () => {} }),
    ).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(f.posts).toHaveLength(1);
  },
);
it('a collector that throws ends the call as on the stream', async () => {
  const f = await execFixture();
  await expect(
    f.provider.run('bq_owned', {
      ...base,
      live: false,
      onChunk: () => {
        throw new Error('too much');
      },
    }),
  ).rejects.toMatchObject({ code: 'provider' });
});

function listing(options: { stack?: string } = {}) {
  const urls: URL[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const mine = (id: string, marker: string) => ({
    id,
    name: id,
    image: 'ghcr.io/briq-cloud/sandbox:latest',
    labels: { [marker]: '1' },
    state: 'running',
    createdAt: '2026-11-02T00:00:00.000Z',
    teamId: 'tm_owned',
  });
  const http = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    urls.push(target);
    if (target.pathname === '/v1/quota')
      return Response.json({
        features: { briqLabels: true },
        availableSizes: ['small'],
        team: { id: 'tm_owned' },
      });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return Response.json({ briqs: [{ ...mine('bq_new', 'mark'), ...body.spec, id: 'bq_new' }] });
    }
    return Response.json({ briqs: [mine('bq_mine', 'mark'), mine('bq_other', 'other')] });
  });
  return {
    provider: nativeSandbox({
      apiKey: 'fixture',
      baseUrl: 'https://api.test',
      fetch: http,
      marker: 'mark',
      eagerChecks: false,
      ...options,
    }),
    urls,
    bodies,
  };
}

it('sends no stack by default and finds its sandboxes by their marker', async () => {
  const f = listing();
  await f.provider.create({ labels: {} });
  expect(f.bodies[0]).not.toHaveProperty('stack');
  expect((await f.provider.list({})).map((row) => row.id)).toEqual(['bq_mine']);
  expect(f.urls.at(-1)?.search).toBe('');
});

it('uses a stack when one is set', async () => {
  const f = listing({ stack: 'agents' });
  await f.provider.create({ labels: {} });
  expect(f.bodies[0]?.stack).toBe('agents');
  await f.provider.list({});
  expect(f.urls.at(-1)?.searchParams.get('stack')).toBe('agents');
});
