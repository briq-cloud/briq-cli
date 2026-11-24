import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const execute = promisify(execFile);
const key = 'bq_sbox_test';
const command = { id: 'ex_one', state: 'exited', exitCode: 0 };

it.each([
  { args: ['exec', 'bq_one', '--', 'true'], paths: ['POST /access', 'POST /exec'] },
  { args: ['exec', '--async', 'bq_one', '--', 'true'], paths: ['POST /exec'] },
  { args: ['exec-result', 'bq_one', 'ex_one'], paths: ['GET /execs/ex_one'] },
  { args: ['exec-stop', 'bq_one', 'ex_one'], paths: ['DELETE /execs/ex_one'] },
  { args: ['files-put', 'bq_one', '/work/hello'], paths: ['PUT /files'] },
  { args: ['files-get', 'bq_one', '/work/hello'], paths: ['GET /files/raw'] },
  { args: ['files-get', 'bq_one', '/work/hello', '--json'], paths: ['GET /files'] },
])(
  'uses only target routes for a scoped $args',
  async ({ args, paths }) => {
    const requests: { path: string; authorization: string | undefined; body: string }[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const path = new URL(req.url!, 'http://localhost').pathname;
      requests.push({
        path: `${req.method} ${path.replace('/v1/briqs/bq_one', '')}`,
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      res.setHeader('content-type', 'application/json');
      if (path === '/v1/briqs/bq_one/access' || !path.startsWith('/v1/briqs/bq_one/')) {
        res.writeHead(403).end(
          JSON.stringify({
            error: { code: 'forbidden', message: 'sandbox operation is not permitted' },
          }),
        );
      } else if (path.endsWith('/exec')) {
        const async = requests.at(-1)!.body.includes('"async":true');
        res.end(
          JSON.stringify(
            async
              ? { exec: command, costLine: 'cost' }
              : {
                  stdout: 'hello',
                  stderr: '',
                  exitCode: 0,
                  timedOut: false,
                  truncated: false,
                  costLine: 'cost',
                },
          ),
        );
      } else if (path.endsWith('/execs/ex_one')) {
        res.end(JSON.stringify({ exec: command, costLine: 'cost' }));
      } else if (path.endsWith('/files/raw')) {
        res.setHeader('content-type', 'application/octet-stream');
        res.end('hello');
      } else if (path.endsWith('/files')) {
        res.end(
          JSON.stringify({
            path: '/work/hello',
            bytes: 5,
            sha256: 'digest',
            verified: true,
            contentBase64: 'aGVsbG8=',
          }),
        );
      } else {
        res.writeHead(403).end(
          JSON.stringify({
            error: { code: 'forbidden', message: 'sandbox operation is not permitted' },
          }),
        );
      }
    });
    const directory = mkdtempSync(join(tmpdir(), 'briq-scoped-cli-'));
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing listener');
      const argv = [...args];
      if (argv[0] === 'files-put') {
        const source = join(directory, 'hello');
        writeFileSync(source, 'hello');
        argv.push(source);
      }
      const run = await execute(process.execPath, [cli, ...argv], {
        timeout: 10_000,
        env: {
          ...process.env,
          BRIQ_API_KEY: key,
          BRIQ_API_URL: `http://127.0.0.1:${address.port}`,
          BRIQ_CONFIG_DIR: directory,
        },
      });
      expect(requests.map((request) => request.path)).toEqual(paths);
      expect(requests.every((request) => request.authorization === `Bearer ${key}`)).toBe(true);
      expect(run.stdout + run.stderr).not.toContain(key);
      if (argv[0] === 'files-put') expect(requests[0]!.body).toBe('hello');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

it.each([
  { args: ['login', '--key', key], path: '/v1/quota' },
  { args: ['whoami'], path: '/v1/quota' },
  { args: ['quota'], path: '/v1/quota' },
  { args: ['status', 'bq_one'], path: '/v1/briqs/bq_one' },
])(
  'does not bypass the documented refusal for scoped $args',
  async ({ args, path }) => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      res.setHeader('content-type', 'application/json');
      res.writeHead(403).end(
        JSON.stringify({
          error: { code: 'forbidden', message: 'sandbox operation is not permitted' },
        }),
      );
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing listener');
      const run = await execute(process.execPath, [cli, ...args], {
        timeout: 10_000,
        env: {
          ...process.env,
          BRIQ_API_KEY: key,
          BRIQ_API_URL: `http://127.0.0.1:${address.port}`,
          BRIQ_CONFIG_DIR: '/dev/null',
        },
      }).then(
        () => null,
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      expect(run).toMatchObject({ code: 1 });
      expect(run!.stderr).toContain('sandbox operation is not permitted');
      expect(run!.stdout + run!.stderr).not.toContain(key);
      expect(requests).toEqual([path]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  },
  15_000,
);
