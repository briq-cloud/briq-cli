import { expect, it, vi } from 'vitest';
import { Briq } from './index.js';

it('reads separately typed safe status without requesting full sandbox configuration', async () => {
  const sandbox = {
    id: 'bq_one',
    name: 'one',
    size: 'nano',
    state: 'running',
    sleep: '1h',
    createdAt: '2026-11-17T12:00:00Z',
    startedAt: null,
    sleepsAt: null,
    lastUsedAt: null,
    costCentsSoFar: 0,
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ sandbox, costLine: 'cost' })));
  const client = new Briq('scoped-bearer', { fetch: fetcher });
  expect(await client.sandboxStatus('bq_one')).toEqual({ sandbox, costLine: 'cost' });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]![0]).toBe('https://api.briq.cloud/v1/briqs/bq_one/status');
});

it('falls back exactly once to central exec when scoped credentials cannot obtain regional access', async () => {
  const calls: string[] = [];
  const result = {
    stdout: 'ok',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    truncated: false,
    costLine: 'cost',
  };
  const control = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    return path.endsWith('/access')
      ? new Response(
          JSON.stringify({
            error: { code: 'forbidden', message: 'sandbox operation is not permitted' },
          }),
          { status: 403 },
        )
      : new Response(JSON.stringify(result));
  });
  const regional = vi.fn<typeof fetch>();
  const client = new Briq('scoped-bearer', { fetch: control, execution: { fetch: regional } });
  expect(await client.exec('bq_one', ['true'])).toEqual(result);
  expect(calls).toEqual(['/v1/briqs/bq_one/access', '/v1/briqs/bq_one/exec']);
  expect(regional).not.toHaveBeenCalled();
});
