import WebSocket from 'ws';
import { type Command, type CommandResult, type OutputChunk, validate } from './native-command.js';
import { fail, refusal } from './native-errors.js';
export type { Command, CommandResult, OutputChunk };
/** Finite-input, non-TTY v1 transport: one START and no reconnect/replay. */
export function runArgv(
  base: string,
  key: string,
  id: string,
  input: Command,
): Promise<CommandResult> {
  if (input.signal?.aborted) return Promise.resolve({ exitCode: null, timedOut: true });
  validate(input);
  const start = Buffer.concat([
    Buffer.from([5]),
    Buffer.from(
      JSON.stringify({
        cmd: input.cmd,
        cwd: input.cwd,
        env: input.env,
        stdin: input.stdin ?? '',
        timeout_ms: input.timeoutMs,
      }),
    ),
  ]);
  if (start.length >= 1048576)
    throw fail('invalid_argument', 'Command START exceeds Briq frame bounds');
  const url = new URL(`/v1/briqs/${encodeURIComponent(id)}/exec/stream`, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${key}` },
      maxPayload: 1048576,
      perMessageDeflate: false,
      followRedirects: false,
      handshakeTimeout: 15000,
    });
    let done = false;
    let started = false;
    let cancelled = false;
    let callbackFailed = false;
    let ack: NodeJS.Timeout | undefined;
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const finish = (result?: CommandResult, error?: ReturnType<typeof fail>) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      clearTimeout(ack);
      input.signal?.removeEventListener('abort', cancel);
      ws.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const lost = () =>
      finish(
        undefined,
        fail(
          started ? 'outcome_unknown' : 'unavailable',
          started
            ? 'Remote command completion and cleanup could not be confirmed'
            : 'Briq command stream unavailable',
        ),
      );
    function cancel() {
      if (done || cancelled) return;
      if (!started) {
        finish({ exitCode: null, timedOut: true });
        return;
      }
      cancelled = true;
      if (ws.readyState !== WebSocket.OPEN) {
        lost();
        return;
      }
      ws.send(Buffer.from([6]), (err) => {
        if (err) lost();
      });
      ack = setTimeout(lost, 12000);
      ack.unref();
    }
    const deadline = setTimeout(cancel, input.timeoutMs + 15000);
    deadline.unref();
    input.signal?.addEventListener('abort', cancel, { once: true });
    ws.on('error', lost);
    ws.on('close', lost);
    ws.on('unexpected-response', (_req, response) => {
      const status = response.statusCode ?? 503;
      const headers = {
        get: (name: string) => {
          const value = response.headers[name];
          return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
        },
      };
      response.destroy();
      finish(undefined, refusal(status, headers));
    });
    ws.on('open', () => {
      if (input.signal?.aborted) {
        cancel();
        return;
      }
      started = true;
      ws.send(start, (err) => {
        if (err) lost();
      });
    });
    const emit = (stream: 'stdout' | 'stderr', text: string) => {
      if (!text || callbackFailed) return;
      try {
        input.onChunk({ stream, text });
      } catch {
        callbackFailed = true;
        cancel();
      }
    };
    ws.on('message', (raw, binary) => {
      if (done) return;
      const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (!binary || !data.length || data.length > 1048576) {
        lost();
        return;
      }
      if (data[0] === 1 || data[0] === 2) {
        const stream = data[0] === 1 ? 'stdout' : 'stderr';
        emit(stream, decoders[stream].decode(data.subarray(1), { stream: true }));
        return;
      }
      if (data[0] !== 3) {
        lost();
        return;
      }
      try {
        const end = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(1)));
        if (
          !end ||
          typeof end !== 'object' ||
          Array.isArray(end) ||
          Object.keys(end).some(
            (k) => !['exit_code', 'timed_out', 'cancelled', 'code', 'error'].includes(k),
          )
        ) {
          lost();
          return;
        }
        if (end.code !== undefined) {
          if (
            typeof end.code !== 'string' ||
            end.exit_code !== undefined ||
            end.cancelled ||
            end.timed_out
          ) {
            lost();
            return;
          }
          const code =
            end.code === 'unsupported'
              ? 'unsupported'
              : end.code === 'invalid'
                ? 'invalid_argument'
                : end.code === 'not_running'
                  ? 'unavailable'
                  : end.code === 'exec_stream_refused'
                    ? 'provider'
                    : 'outcome_unknown';
          finish(undefined, fail(code, `Briq command failed (${code}); native error text omitted`));
          return;
        }
        if (
          !Number.isInteger(end.exit_code) ||
          end.exit_code < 0 ||
          end.exit_code > 255 ||
          end.error !== undefined ||
          (end.cancelled !== undefined && typeof end.cancelled !== 'boolean') ||
          (end.timed_out !== undefined && typeof end.timed_out !== 'boolean')
        ) {
          lost();
          return;
        }
        emit('stdout', decoders.stdout.decode());
        emit('stderr', decoders.stderr.decode());
        if (callbackFailed) {
          finish(undefined, fail('provider', 'Output callback failed; remote command has ended'));
          return;
        }
        finish({
          exitCode: end.cancelled || end.timed_out ? null : end.exit_code,
          timedOut: !!(end.cancelled || end.timed_out),
        });
      } catch {
        lost();
      }
    });
  });
}
