import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runArgv } from './native-exec.js';

let server: ReturnType<typeof createServer>;
let base: string;
let answer: { status: number; headers: Record<string, string> };
beforeAll(async () => {
  server = createServer((_req, res) => res.end());
  server.on('upgrade', (_req, socket) => {
    const headers = Object.entries(answer.headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('');
    socket.end(
      `HTTP/1.1 ${answer.status} Error\r\nConnection: close\r\n${headers}Content-Length: 0\r\n\r\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
const command = { cmd: ['true'], cwd: '/', env: {}, timeoutMs: 1000, onChunk: () => {} };

it('a rate-limited upgrade maps like the plain call: quota, with the wait', async () => {
  answer = { status: 429, headers: { 'retry-after': '23' } };
  await expect(runArgv(base, 'k', 'bq_x', command)).rejects.toMatchObject({
    code: 'quota',
    retryAfterSeconds: 23,
    message: 'Briq command refused (quota); retry in 23s',
  });
});
it('other upgrade refusals keep their codes and carry no wait', async () => {
  answer = { status: 404, headers: { 'retry-after': '23' } };
  const error = await runArgv(base, 'k', 'bq_x', command).catch((e) => e);
  expect(error).toMatchObject({ code: 'not_found', message: 'Briq command refused (not_found)' });
  expect(error.retryAfterSeconds).toBeUndefined();
});
