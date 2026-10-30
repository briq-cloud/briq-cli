import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { afterEach, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { runShell } from './shell.js';

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      for (const socket of server.clients) socket.terminate();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});
const setup = async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  servers.push(server);
  await once(server, 'listening');
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((raw: boolean) => {
      input.isRaw = raw;
      return input;
    }),
  });
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  const signals = new EventEmitter();
  const terminal = {
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream,
    signals,
  };
  let printed = '';
  output.on('data', (chunk) => {
    printed += chunk.toString();
  });
  const handshake = {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    headers: { authorization: 'Bearer client-key' },
  };
  return { server, input, output, signals, terminal, handshake, printed: () => printed };
};
it('forwards raw control bytes and resizes, streams output, preserves exit code and restores the terminal', async () => {
  const t = await setup();
  const connected = once(t.server, 'connection');
  const done = runShell(t.handshake, t.terminal);
  const [socket, request] = await connected;
  const peer = socket as WebSocket;
  expect(request.headers.authorization).toBe('Bearer client-key');
  const frames: Buffer[] = [];
  peer.on('message', (data) => frames.push(Buffer.from(data as Buffer)));
  await vi.waitFor(() => expect(t.input.isRaw).toBe(true));
  t.input.write(Buffer.from([3, 4, 27]));
  t.output.columns = 120;
  t.output.rows = 50;
  t.output.emit('resize');
  await vi.waitFor(() => expect(frames).toHaveLength(3));
  expect(frames[1]).toEqual(Buffer.from([0, 3, 4, 27]));
  expect(JSON.parse(frames[2]!.subarray(1).toString())).toEqual({ cols: 120, rows: 50 });
  peer.send(Buffer.concat([Buffer.from([1]), Buffer.from('hello terminal')]));
  peer.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"exit_code":7}')]));
  expect(await done).toBe(7);
  expect(t.printed()).toBe('hello terminal');
  expect(t.input.isRaw).toBe(false);
  expect(t.signals.listenerCount('SIGTERM')).toBe(0);
});
it('restores the terminal and closes the socket on a process signal', async () => {
  const t = await setup();
  const connected = once(t.server, 'connection');
  const done = runShell(t.handshake, t.terminal);
  const [peer] = await connected;
  await vi.waitFor(() => expect(t.input.isRaw).toBe(true));
  const closed = once(peer, 'close');
  t.signals.emit('SIGTERM');
  expect(await done).toBe(143);
  await closed;
  expect(t.input.isRaw).toBe(false);
});
it('treats transport closure without a remote exit as failure and restores prior raw mode', async () => {
  const t = await setup();
  t.input.isRaw = true;
  const connected = once(t.server, 'connection');
  const done = runShell(t.handshake, t.terminal);
  const rejected = expect(done).rejects.toThrow('without an exit code');
  const [peer] = await connected;
  await vi.waitFor(() => expect(t.input.setRawMode).toHaveBeenCalledWith(true));
  peer.terminate();
  await rejected;
  expect(t.input.isRaw).toBe(true);
  expect(t.input.setRawMode).toHaveBeenLastCalledWith(true);
});
it('refuses piped stdin before opening a socket', async () => {
  const t = await setup();
  t.input.isTTY = false;
  expect(() => runShell(t.handshake, t.terminal)).toThrow('interactive terminal');
  expect(t.server.clients.size).toBe(0);
});

it('returns the signal status when interrupted during the handshake without changing terminal mode', async () => {
  const t = await setup();
  const done = runShell(t.handshake, t.terminal);
  t.signals.emit('SIGTERM');
  expect(await done).toBe(143);
  expect(t.input.isRaw).toBe(false);
  expect(t.input.setRawMode).not.toHaveBeenCalled();
});

it('restores the terminal and fails when a connected server goes silent', async () => {
  const t = await setup();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  try {
    const connected = once(t.server, 'connection');
    const done = runShell(t.handshake, t.terminal);
    const rejected = expect(done).rejects.toThrow('terminal connection timed out');
    const [peer] = await connected;
    await vi.waitFor(() => expect(t.input.isRaw).toBe(true));
    const closed = once(peer, 'close');
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    await closed;
    expect(t.input.isRaw).toBe(false);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.signals.listenerCount('SIGTERM')).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('refreshes its read watchdog on server heartbeats while a quiet shell is open', async () => {
  const t = await setup();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  try {
    const connected = once(t.server, 'connection');
    const done = runShell(t.handshake, t.terminal);
    const [peer] = await connected;
    await vi.waitFor(() => expect(t.input.isRaw).toBe(true));
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      const pong = once(peer, 'pong');
      peer.ping();
      await pong;
      expect(t.input.isRaw).toBe(true);
    }
    peer.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"exit_code":0}')]));
    expect(await done).toBe(0);
    expect(t.input.isRaw).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('returns the runtime timeout exit without reconnecting and restores the terminal', async () => {
  const t = await setup();
  const connected = once(t.server, 'connection');
  const done = runShell(t.handshake, t.terminal);
  const [peer] = await connected;
  await vi.waitFor(() => expect(t.input.isRaw).toBe(true));
  peer.send(Buffer.concat([Buffer.from([3]), Buffer.from('{"exit_code":137,"timed_out":true}')]));
  expect(await done).toBe(137);
  expect(t.input.isRaw).toBe(false);
  expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
});
