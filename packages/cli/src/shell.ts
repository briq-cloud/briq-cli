import type { ReadStream, WriteStream } from 'node:tty';
import { BriqApiError } from '@briq/sdk';
import WebSocket, { type RawData } from 'ws';
import { usage } from './errors.js';
import { USER_AGENT } from './session.js';

interface Terminal {
  input: ReadStream;
  output: WriteStream;
  signals: NodeJS.EventEmitter;
}
const bytesOf = (raw: RawData) =>
  Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);

/** One terminal, one command. Leaving it restores local terminal settings and closes its socket. */
export function runShell(
  handshake: { url: string; headers: Record<string, string> },
  terminal: Terminal = { input: process.stdin, output: process.stdout, signals: process },
): Promise<number> {
  const { input, output, signals } = terminal;
  if (!input.isTTY || !output.isTTY)
    throw usage('briq shell needs an interactive terminal; use briq exec for scripts');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(handshake.url, {
      headers: { ...handshake.headers, 'user-agent': USER_AGENT },
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 35_000,
    });
    const wasRaw = input.isRaw;
    let connected = false;
    let done = false;
    let exit: number | undefined;
    let force: NodeJS.Timeout | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let heardAt = 0;
    const heard = () => {
      heardAt = Date.now();
    };
    const restore = () => {
      if (connected) {
        try {
          input.setRawMode(wasRaw);
        } catch {
          /* The terminal may already be gone. */
        }
        input.pause();
      }
    };
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      restore();
      clearTimeout(force);
      clearInterval(watchdog);
      input.off('data', sendInput);
      input.off('error', streamError);
      output.off('error', streamError);
      output.off('resize', resize);
      output.off('drain', drain);
      signals.off('SIGINT', interrupt);
      signals.off('SIGTERM', terminate);
      signals.off('SIGHUP', hangup);
      signals.off('exit', restore);
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (err) reject(err);
      else resolve(exit ?? 1);
    };
    const close = (code: number) => {
      exit = code;
      restore();
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
      force = setTimeout(() => finish(), 5000);
      force.unref();
    };
    const streamError = () => finish(new Error('local terminal closed'));
    const interrupt = () => close(130);
    const terminate = () => close(143);
    const hangup = () => close(129);
    const send = (data: Buffer, callback?: (err?: Error) => void) => {
      if (
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount + data.length > 4 * 1024 * 1024
      ) {
        close(1);
        return;
      }
      socket.send(data, { binary: true, compress: false }, callback);
    };
    const sendInput = (data: Buffer) => {
      input.pause();
      send(Buffer.concat([Buffer.from([0]), data]), (err) => {
        // Read the command's exit even if it ended while the last keys were being sent.
        if (!err && !done && socket.readyState === WebSocket.OPEN) input.resume();
      });
    };
    const resize = () =>
      send(
        Buffer.concat([
          Buffer.from([4]),
          Buffer.from(
            JSON.stringify({
              cols: Math.min(1000, Math.max(1, output.columns || 80)),
              rows: Math.min(1000, Math.max(1, output.rows || 24)),
            }),
          ),
        ]),
      );
    const drain = () => {
      if (socket.readyState === WebSocket.OPEN) socket.resume();
    };
    signals.on('SIGINT', interrupt);
    signals.on('SIGTERM', terminate);
    signals.on('SIGHUP', hangup);
    signals.on('exit', restore);
    socket.on('open', () => {
      connected = true;
      try {
        input.setRawMode(true);
      } catch {
        finish(new Error('could not enter terminal raw mode'));
        return;
      }
      heard();
      watchdog = setInterval(() => {
        if (Date.now() - heardAt >= 90_000) finish(new Error('terminal connection timed out'));
      }, 15_000);
      watchdog.unref();
      input.on('error', streamError);
      output.on('error', streamError);
      input.on('data', sendInput);
      output.on('resize', resize);
      resize();
      input.resume();
    });
    socket.on('ping', heard);
    socket.on('pong', heard);
    socket.on('message', (raw, binary) => {
      heard();
      const data = bytesOf(raw);
      if (!binary || !data.length) {
        finish(new Error('invalid terminal response'));
        return;
      }
      if (data[0] === 1 || data[0] === 2) {
        if (!output.write(data.subarray(1))) {
          socket.pause();
          output.once('drain', drain);
        }
      } else if (data[0] === 3) {
        try {
          const end = JSON.parse(data.subarray(1).toString()) as { exit_code?: unknown };
          if (
            typeof end.exit_code !== 'number' ||
            !Number.isInteger(end.exit_code) ||
            end.exit_code < 0 ||
            end.exit_code > 255
          )
            throw new Error();
          close(end.exit_code);
        } catch {
          finish(new Error('terminal command ended without an exit code'));
        }
      } else finish(new Error('invalid terminal response'));
    });
    socket.on('unexpected-response', (_req, response) => {
      const status = response.statusCode ?? 500;
      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > 4096) {
          response.destroy();
          finish(new BriqApiError(status, 'error', `terminal request refused (HTTP ${status})`));
        }
      });
      response.on('end', () => {
        let error: { code?: string; message?: string } = {};
        try {
          error = JSON.parse(body).error ?? {};
        } catch {
          /* A proxy may answer with HTML. */
        }
        finish(
          new BriqApiError(
            status,
            error.code ?? 'error',
            error.message ?? `terminal request refused (HTTP ${status})`,
          ),
        );
      });
      response.on('error', () => finish(new Error('terminal request failed')));
    });
    socket.on('error', () =>
      finish(exit === undefined ? new Error('terminal connection failed') : undefined),
    );
    socket.on('close', () =>
      finish(
        exit === undefined
          ? new Error('terminal connection closed without an exit code')
          : undefined,
      ),
    );
  });
}
