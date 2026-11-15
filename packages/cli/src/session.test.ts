import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { USER_AGENT, openSession } from './session.js';

const result = {
  stdout: 'done',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  truncated: false,
  costLine: 'current cost',
};
const json = (value: unknown) => new Response(JSON.stringify(value));

beforeEach(() => {
  vi.stubEnv('BRIQ_CONFIG_DIR', mkdtempSync(join(tmpdir(), 'briq-session-')));
  vi.stubEnv('BRIQ_API_URL', 'https://control.example');
  vi.stubEnv('BRIQ_API_KEY', 'source-key');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('uses separate scoped execution credentials after discovery', async () => {
  const transport = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    json(
      String(url).endsWith('/access')
        ? {
            version: 1,
            briqId: 'bq_one',
            origin: 'https://commands.example',
            region: 'region-one',
            operations: ['exec'],
            transports: ['http'],
            token: 'scoped-token',
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            routeGeneration: 'generation-one',
          }
        : result,
    ),
  );
  vi.stubGlobal('fetch', transport);
  expect(await (await openSession()).client.exec('bq_one', ['true'])).toEqual(result);
  expect(transport).toHaveBeenCalledTimes(2);
  const [controlUrl, control] = transport.mock.calls[0]!;
  expect(controlUrl).toBe('https://control.example/v1/briqs/bq_one/access');
  expect(new Headers(control?.headers).get('authorization')).toBe('Bearer source-key');
  expect(new Headers(control?.headers).get('user-agent')).toBe(USER_AGENT);
  const [commandUrl, command] = transport.mock.calls[1]!;
  expect(commandUrl).toBe('https://commands.example/v1/briqs/bq_one/exec');
  expect(new Headers(command?.headers).get('authorization')).toBe('Bearer scoped-token');
  expect(new Headers(command?.headers).get('cookie')).toBeNull();
  expect(command?.credentials).toBe('omit');
  expect(command?.redirect).toBe('error');
});
