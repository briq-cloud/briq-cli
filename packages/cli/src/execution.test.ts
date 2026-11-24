import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const execute = promisify(execFile);

it('no longer takes an execution option', () => {
  const run = spawnSync(
    process.execPath,
    [cli, 'exec', '--execution', 'regional', 'bq_one', '--', 'true'],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        BRIQ_API_KEY: '',
        BRIQ_API_URL: 'https://unused.invalid',
        BRIQ_CONFIG_DIR: '/dev/null',
      },
    },
  );
  expect(run.error).toBeUndefined();
  expect(run.status).not.toBe(0);
});

it('falls back to the API when access is unsupported, and preserves command options after --', async () => {
  const requests: { path: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/access')) {
      res
        .writeHead(404)
        .end(
          JSON.stringify({ error: { code: 'no_regional_route', message: 'no regional route' } }),
        );
    } else {
      res.end(
        JSON.stringify({
          stdout: 'done',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          truncated: false,
          costLine: 'current cost',
        }),
      );
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    const run = await execute(
      process.execPath,
      [cli, 'exec', 'bq_one', '--', 'tool', '--execution', 'regional'],
      {
        timeout: 5000,
        env: {
          ...process.env,
          BRIQ_API_KEY: 'test-key',
          BRIQ_API_URL: `http://127.0.0.1:${address.port}`,
          BRIQ_CONFIG_DIR: '/dev/null',
        },
      },
    );
    expect(run.stdout).toBe('done');
    expect(requests.map((r) => r.path)).toEqual([
      '/v1/briqs/bq_one/access',
      '/v1/briqs/bq_one/exec',
    ]);
    expect(requests[1]?.body).toMatchObject({ cmd: ['tool', '--execution', 'regional'] });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('asks a create for command access, and prints none if the API sends it', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type', 'application/json');
    res.writeHead(201).end(
      JSON.stringify({
        briqs: [],
        outputs: {},
        recipe: null,
        costLine: 'cost',
        ready: true,
        access: { bq_one: { token: 'secret-execution-grant' } },
      }),
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    const run = await execute(process.execPath, [cli, 'run', 'redis:7', '--json'], {
      timeout: 5000,
      env: {
        ...process.env,
        BRIQ_API_KEY: 'test-key',
        BRIQ_API_URL: `http://127.0.0.1:${address.port}`,
        BRIQ_CONFIG_DIR: '/dev/null',
      },
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ access: { version: 1, operations: ['exec'] } });
    expect(run.stdout + run.stderr).not.toContain('secret-execution-grant');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('forwards recipe allowlists and image deny-all through the HTTP API', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('content-type', 'application/json');
    res.writeHead(201).end(JSON.stringify({ briqs: [], outputs: {}, costLine: 'cost' }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    const env = {
      ...process.env,
      BRIQ_API_KEY: 'test-key',
      BRIQ_API_URL: `http://127.0.0.1:${address.port}`,
      BRIQ_CONFIG_DIR: '/dev/null',
    };
    await execute(
      process.execPath,
      [
        cli,
        'run',
        'node',
        '--egress-host',
        'API.Example.com',
        '--egress-host',
        'registry.npmjs.org',
      ],
      { timeout: 5000, env },
    );
    await execute(process.execPath, [cli, 'run', 'alpine:3', '--egress-deny-all'], {
      timeout: 5000,
      env,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      recipe: 'node',
      egress: { hosts: ['api.example.com', 'registry.npmjs.org'] },
    });
    expect(bodies[1]).toMatchObject({ spec: { egress: { hosts: [] } } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
