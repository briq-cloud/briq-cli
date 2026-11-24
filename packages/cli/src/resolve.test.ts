import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const execute = promisify(execFile);

const briq = (id: string, name: string, stackId: string) => ({
  id,
  name,
  stackId,
  state: 'running',
});

/** A fake API that lists `briqs` and records every request it gets. */
async function withApi(
  briqs: ReturnType<typeof briq>[],
  test: (
    run: (...args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>,
    paths: string[],
  ) => Promise<void>,
) {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/v1/briqs?') || req.url === '/v1/briqs')
      return void res.end(JSON.stringify({ briqs, costLine: 'cost' }));
    if (req.url?.endsWith('/access'))
      return void res
        .writeHead(404)
        .end(
          JSON.stringify({ error: { code: 'no_regional_route', message: 'no regional route' } }),
        );
    res.end(
      JSON.stringify({
        stdout: 'done',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false,
        costLine: 'cost',
      }),
    );
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing listener');
    const run = async (...args: string[]) => {
      try {
        const r = await execute(process.execPath, [cli, ...args], {
          timeout: 5000,
          env: {
            ...process.env,
            BRIQ_API_KEY: 'test-key',
            BRIQ_API_URL: `http://127.0.0.1:${address.port}`,
            BRIQ_CONFIG_DIR: '/dev/null',
          },
        });
        return { ...r, code: 0 };
      } catch (e) {
        const f = e as { stdout: string; stderr: string; code: number };
        return { stdout: f.stdout, stderr: f.stderr, code: f.code };
      }
    };
    await test(run, paths);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it('runs a command in the briq a name points to, as it does for its id', async () => {
  await withApi(
    [briq('bq_aaaaaaaaaaaa', 'other', 'st_1'), briq('bq_gdh4fr6ho24i', 'syl311-burst-1', 'st_1')],
    async (run, paths) => {
      const r = await run('exec', 'syl311-burst-1', '--', 'echo', 'hi');
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('done');
      expect(paths).toContain('POST /v1/briqs/bq_gdh4fr6ho24i/exec');
      expect(paths.some((p) => p.includes('syl311'))).toBe(false);
    },
  );
});

it('does not list the team when it is given an id', async () => {
  await withApi([briq('bq_gdh4fr6ho24i', 'syl311-burst-1', 'st_1')], async (run, paths) => {
    const r = await run('exec', 'bq_gdh4fr6ho24i', '--', 'echo', 'hi');
    expect(r.code).toBe(0);
    expect(paths.some((p) => p.startsWith('GET /v1/briqs?') || p === 'GET /v1/briqs')).toBe(false);
  });
});

it('refuses a name two stacks share, naming both ids, and sends nothing to either', async () => {
  await withApi(
    [briq('bq_aaaaaaaaaaaa', 'web', 'st_1'), briq('bq_bbbbbbbbbbbb', 'web', 'st_2')],
    async (run, paths) => {
      const r = await run('exec', 'web', '--', 'true');
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('bq_aaaaaaaaaaaa');
      expect(r.stderr).toContain('bq_bbbbbbbbbbbb');
      expect(paths.some((p) => p.includes('/exec'))).toBe(false);
    },
  );
});

it('says no briq has that name when none does', async () => {
  await withApi([briq('bq_aaaaaaaaaaaa', 'web', 'st_1')], async (run, paths) => {
    const r = await run('exec', 'missing', '--', 'true');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/no briq named missing/);
    expect(paths.some((p) => p.includes('/exec'))).toBe(false);
  });
});

it('checks its own options before it looks a name up', async () => {
  await withApi([briq('bq_aaaaaaaaaaaa', 'web', 'st_1')], async (run, paths) => {
    const r = await run('exec', 'web', '--stdin-open', '--', 'true');
    expect(r.code).toBe(2);
    expect(paths).toEqual([]);
  });
});
