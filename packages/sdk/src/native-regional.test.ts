import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import type { Command } from './native-command.js';
import { runArgv } from './native-exec.js';
import { IN_DIR } from './native-rest-exec.js';
import { nativeSandbox } from './native-sandbox.js';
vi.mock('./native-exec.js', () => ({ runArgv: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const result = {
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  truncated: false,
  costLine: 'cost',
};
const command = (extra: Partial<Command> = {}): Command => ({
  cmd: ['printf', 'ok'],
  cwd: '/workspace',
  env: { A: 'value' },
  stdin: 'input',
  timeoutMs: 2000,
  live: false,
  onChunk: () => {},
  ...extra,
});
function fixture(custom = true) {
  let revision = 0;
  const control = vi.fn<typeof fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/access'))
      return Response.json({
        version: 1,
        briqId: 'bq_owned',
        region: 'region',
        origin: 'https://execution.test',
        token: `execution-${++revision}`,
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
        routeGeneration: 'generation',
        operations: ['exec'],
        transports: ['http'],
        maxCommands: 2,
      });
    if (path.endsWith('/exec')) return Response.json(result);
    return Response.json({
      briq: {
        id: 'bq_owned',
        image: 'ghcr.io/briq-cloud/sandbox:latest',
        state: 'running',
        createdAt: new Date().toISOString(),
        labels: { 'briq/opencore-provider': '1' },
      },
    });
  });
  const regional = vi.fn<typeof fetch>(async () => Response.json(result));
  const client = nativeSandbox({
    apiKey: 'control-only',
    baseUrl: 'https://control.test',
    ...(custom ? { fetch: control } : {}),
    execution: { ...(custom ? { fetch: regional, maxCommands: 2 } : {}) },
  });
  return { client, control, regional };
}
it('shares negotiated cached grants while keeping control credentials and execution transports separate', async () => {
  const f = fixture();
  const chunks: string[] = [];
  await f.client.run('bq_owned', command({ onChunk: (c) => chunks.push(c.text) }));
  await f.client.run('bq_owned', command());
  expect(f.control.mock.calls.filter(([url]) => String(url).endsWith('/access'))).toHaveLength(1);
  expect(JSON.parse(f.control.mock.calls[1]![1]!.body as string).maxCommands).toBe(2);
  expect(new Headers(f.control.mock.calls[1]![1]!.headers).get('authorization')).toBe(
    'Bearer control-only',
  );
  expect(f.regional).toHaveBeenCalledTimes(2);
  expect(chunks).toEqual(['ok']);
  const [url, init] = f.regional.mock.calls[0]!;
  expect(url).toBe('https://execution.test/v1/briqs/bq_owned/exec');
  expect(new Headers(init!.headers).get('authorization')).toBe('Bearer execution-1');
  expect(init).toMatchObject({
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  expect(JSON.parse(init!.body as string)).toEqual({
    cmd: ['/bin/sh', '-c', IN_DIR, 'briq-cwd', '/workspace', 'printf', 'ok'],
    timeoutMs: 2000,
    env: { A: 'value' },
    stdin: 'input',
  });
  await f.client.run('bq_owned', command());
  expect(f.control.mock.calls.filter(([url]) => String(url).endsWith('/access'))).toHaveLength(2);
  expect(new Headers(f.regional.mock.calls[2]![1]!.headers).get('authorization')).toBe(
    'Bearer execution-2',
  );
});
it('does not classify its default fetch wrapper as a custom control transport', async () => {
  const f = fixture();
  const transport = vi.fn<typeof fetch>(async (url, init) =>
    String(url).startsWith('https://execution.test') ? f.regional(url, init) : f.control(url, init),
  );
  vi.stubGlobal('fetch', transport);
  const client = fixture(false).client;
  await client.run('bq_owned', command());
  expect(f.regional).toHaveBeenCalledOnce();
  expect(JSON.parse(f.control.mock.calls[1]![1]!.body as string).maxCommands).toBe(4);
});
it.each(['lost', 'malformed', 'refused', 'bad-exit', 'bad-timeout'])(
  'never falls back or repeats an uncertain regional command: %s',
  async (failure) => {
    const f = fixture();
    f.regional.mockImplementation(async () => {
      if (failure === 'lost') throw new Error('closed');
      if (failure === 'malformed') return new Response('{');
      if (failure === 'refused')
        return Response.json({ error: { details: { op: 'get machine' } } }, { status: 503 });
      return Response.json({
        ...result,
        ...(failure === 'bad-exit' ? { exitCode: 256 } : { timedOut: 'false' }),
      });
    });
    await expect(f.client.run('bq_owned', command())).rejects.toMatchObject({
      code: 'outcome_unknown',
    });
    expect(f.regional).toHaveBeenCalledOnce();
    expect(f.control.mock.calls.some(([url]) => String(url).endsWith('/exec'))).toBe(false);
  },
);
it('falls back only during supported discovery failures before dispatch', async () => {
  const f = fixture();
  const original = f.control.getMockImplementation()!;
  f.control.mockImplementation(async (url, init) =>
    String(url).endsWith('/access')
      ? Response.json({ error: { code: 'not_found' } }, { status: 404 })
      : original(url, init),
  );
  await f.client.run('bq_owned', command());
  expect(f.regional).not.toHaveBeenCalled();
  expect(f.control.mock.calls.filter(([url]) => String(url).endsWith('/exec'))).toHaveLength(1);
});
it('runs the command through the API when the regional origin cannot be connected to, and only then', async () => {
  const f = fixture();
  const centralRuns = () =>
    f.control.mock.calls.filter(([url]) => String(url).endsWith('/exec')).length;
  f.regional.mockRejectedValueOnce(
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
  );
  await expect(f.client.run('bq_owned', command())).resolves.toBeDefined();
  expect(f.regional).toHaveBeenCalledTimes(1);
  expect(centralRuns()).toBe(1);
  // A failure after the connection was made is never repeated through the API.
  const g = fixture();
  g.regional.mockRejectedValueOnce(
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
  );
  await expect(g.client.run('bq_owned', command())).rejects.toBeDefined();
  expect(g.control.mock.calls.filter(([url]) => String(url).endsWith('/exec'))).toHaveLength(0);
});
it('sends the negotiated request once over a real loopback HTTP execution transport', async () => {
  const received: Array<{
    authorization: string | undefined;
    path: string | undefined;
    body: unknown;
  }> = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    received.push({
      authorization: req.headers.authorization,
      path: req.url,
      body: JSON.parse(Buffer.concat(parts).toString()),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const f = fixture();
    const transport: typeof fetch = (url, init) =>
      fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}${new URL(String(url)).pathname}`,
        init,
      );
    const client = nativeSandbox({
      apiKey: 'control-only',
      baseUrl: 'https://control.test',
      fetch: f.control,
      execution: { fetch: transport, maxCommands: 2 },
    });
    await client.run('bq_owned', command());
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      authorization: 'Bearer execution-1',
      path: '/v1/briqs/bq_owned/exec',
      body: { stdin: 'input', env: { A: 'value' } },
    });
    expect(f.control.mock.calls.some(([url]) => String(url).endsWith('/exec'))).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('keeps streaming commands on the existing central native transport', async () => {
  const f = fixture();
  vi.mocked(runArgv).mockReset().mockResolvedValue({ exitCode: 0, timedOut: false });
  await f.client.run('bq_owned', command({ live: true }));
  expect(runArgv).toHaveBeenCalledOnce();
  expect(f.regional).not.toHaveBeenCalled();
  expect(f.control.mock.calls.some(([url]) => String(url).endsWith('/access'))).toBe(false);
});
it('uses the API route with a custom control fetch and no execution transport', async () => {
  const f = fixture();
  const client = nativeSandbox({
    apiKey: 'control-only',
    baseUrl: 'https://control.test',
    fetch: f.control,
  });
  await client.run('bq_owned', command());
  expect(f.regional).not.toHaveBeenCalled();
  expect(f.control.mock.calls.some(([url]) => String(url).endsWith('/access'))).toBe(false);
  expect(f.control.mock.calls.filter(([url]) => String(url).endsWith('/exec'))).toHaveLength(1);
});
it('runs the first command on the access the create answered with, and returns none of it', async () => {
  const calls: string[] = [];
  const grant = {
    version: 1,
    briqId: 'bq_owned',
    region: 'region',
    origin: 'https://execution.test',
    token: 'from-create',
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
    routeGeneration: 'generation',
    operations: ['exec'],
    transports: ['http'],
  };
  const control = vi.fn<typeof fetch>(async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`);
    if (init?.method === 'POST')
      return Response.json({
        briqs: [
          {
            ...JSON.parse(String(init.body)).spec,
            id: 'bq_owned',
            state: 'running',
            createdAt: new Date().toISOString(),
          },
        ],
        access: { bq_owned: grant },
      });
    return Response.json({ briq: { id: 'bq_owned', state: 'running' } });
  });
  const regional = vi.fn<typeof fetch>(async () => Response.json(result));
  const client = nativeSandbox({
    apiKey: 'control-only',
    baseUrl: 'https://control.test',
    fetch: control,
    eagerChecks: false,
    execution: { fetch: regional },
  });
  const created = await client.create({ labels: {} });
  expect(JSON.parse(String(control.mock.calls[0]![1]!.body)).access).toEqual({
    version: 1,
    operations: ['exec'],
  });
  expect(JSON.stringify(created)).not.toContain('from-create');
  await client.run('bq_owned', command());
  expect(calls).toEqual(['POST /v1/briqs']);
  expect(new Headers(regional.mock.calls[0]![1]!.headers).get('authorization')).toBe(
    'Bearer from-create',
  );
});
