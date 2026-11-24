import { BriqApiError } from './errors.js';
import { RegionalNotReached, neverConnected } from './execution.js';
import { type Command, type CommandResult, bytes, validate } from './native-command.js';
import { BriqOperationError, fail, refusal, statusCode } from './native-errors.js';

/*
 * A short command over `POST /v1/briqs/{id}/exec`, on the HTTP client the SDK already holds open
 * (the create just before it used the same connection), instead of a new WebSocket: no TCP+TLS
 * handshake, no upgrade, no second API-to-runtime connection.
 *
 * The route answers once, when the command has ended. So it serves a command only when nothing
 * needs the stream, and the WebSocket (`native-exec.ts`) keeps everything else.
 */

/** The route's own limit for a call without `async`. */
const ROUTE_MAX_MS = 60_000;
/** The route refuses a `timeoutMs` under a second (`ExecBody`). */
const ROUTE_MIN_MS = 1_000;
/**
 * Time for the rest of the call on top of the command's own timeout: waking a sleeping briq, the
 * guest taking the command, the round trip.
 */
const ROUND_TRIP_MS = 30_000;
/**
 * The most argv bytes sent over HTTP. Some providers carry only about 16 KB of request per exec
 * in all; the WebSocket takes 128 KB, so a longer command goes there.
 */
const ROUTE_ARGV_BYTES = 8_192;
/** What the exec route accepts as `env`: variable names and their total size. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROUTE_ENV_BYTES = 32 * 1024;
/**
 * The most of an answer that is read: the route sets no cap of its own, the provider does (a few
 * MiB a stream, then either `truncated` or a refusal, depending on the provider). A stream in
 * JSON can be several times its size, with every control character a six-byte escape.
 */
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
/** A refusal's body is read for its code and operation only. */
const MAX_REFUSAL_BYTES = 64 * 1024;

/**
 * Whether the HTTP route can stand in for the WebSocket with the same result:
 * - `live` is false: nobody reads the output as it comes (the route has it only at the end);
 * - no `signal`: the WebSocket confirms a cancellation (the process group is gone), the route
 *   cannot, and an aborted fetch leaves the command running;
 * - a timeout the route runs whole (1 s to 60 s): above it the route would run with 60 s;
 * - an argv, environment and cwd the route accepts as they are.
 * The same bounds `validate` checks still apply first, for both routes.
 */
export function viaHttp(input: Command): boolean {
  if (input.live !== false || input.signal) return false;
  if (input.timeoutMs < ROUTE_MIN_MS || input.timeoutMs > ROUTE_MAX_MS) return false;
  if (input.cmd.reduce((n, s) => n + bytes(s), 0) + bytes(input.cwd) > ROUTE_ARGV_BYTES)
    return false;
  const env = Object.entries(input.env);
  return (
    env.every(([k]) => ENV_NAME.test(k)) &&
    env.reduce((n, [k, v]) => n + k.length + bytes(v), 0) <= ROUTE_ENV_BYTES
  );
}

/**
 * The route has no working directory. The command runs from a shell that changes into it first
 * (`$1` is the directory, the rest is the command, never part of the script):
 * - a directory that is not there ends the command with 126, before it starts, and says so on stderr;
 * - `PWD` and `OLDPWD` are unset again, so the command's environment is the one it has on the
 *   stream, which sets neither;
 * - the shell is `/bin/sh`, not `sh`: with an `env` the provider runs this under the caller's `PATH`.
 */
export const IN_DIR =
  'cd "$1" || { printf \'briq: cannot enter %s\\n\' "$1" >&2; exit 126; }; unset PWD OLDPWD; shift; exec "$@"';

/** The argv the route runs for `input`. */
export const inDir = (input: Command) => [
  '/bin/sh',
  '-c',
  IN_DIR,
  'briq-cwd',
  input.cwd,
  ...input.cmd,
];

/** The body as text, at most `limit` bytes of it: past that the read stops and says so. */
async function readLimited(res: Response, limit: number): Promise<string | undefined> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** What a refusal of the exec carries, read for the code only; no text of it reaches an error. */
interface Said {
  /** The operation that failed, of a 503 (`exec`, `get machine`, `list tenants`). */
  op?: string;
  /** The provider's own reason, of a 409. */
  providerSaid?: string;
}
/** A machine that went down under a command that had started (providers word it either way). */
const WENT_DOWN = /went down during the command|exec request failed: EOF/i;

/**
 * The code of a refusal, which says whether the command may have run. Before it ran (and so safe
 * for the caller to try again):
 * - a 409 (the briq is not running, or busy), unless the provider says the machine went down
 *   during the command: every provider answers a command lost mid-run that way;
 * - a 503 from anything but the exec itself.
 * After it may have: that 409, any other 5xx, a 503 from the exec ("the provider did not answer")
 * and a 503 that is not ours.
 */
function refusalCode(status: number, said: Said) {
  if (status === 409)
    return said.providerSaid !== undefined && WENT_DOWN.test(said.providerSaid)
      ? 'outcome_unknown'
      : 'unavailable';
  if (status === 413) return 'invalid_argument';
  if (status === 503)
    return said.op !== undefined && said.op !== 'exec' ? 'unavailable' : 'outcome_unknown';
  return status >= 500 ? 'outcome_unknown' : statusCode(status);
}

const unconfirmed = () =>
  fail('outcome_unknown', 'Remote command completion could not be confirmed');

/**
 * `fetch` is the SDK's HTTP client, called once: the command is never sent twice. Errors are the
 * WebSocket's: a refusal before the command ran maps by status, and anything after it was sent
 * (no answer, an answer that is not a result, a 5xx) is `outcome_unknown`, never retried. A
 * connection that was never made proves nothing was sent: `unavailable`. A socket that closed
 * under a request proves nothing, so it stays unknown.
 */
export async function runHttp(
  fetcher: typeof fetch,
  base: string,
  key: string,
  id: string,
  input: Command,
  /** Negotiated execution dispatch; the central path retains its original refusal semantics. */
  regional?: { send(body: object): Promise<Response> },
): Promise<CommandResult> {
  validate(input);
  const body = {
    cmd: inDir(input),
    timeoutMs: input.timeoutMs,
    // An empty stdin is no stdin, as on the stream.
    ...(input.stdin ? { stdin: input.stdin } : {}),
    ...(Object.keys(input.env).length ? { env: input.env } : {}),
  };
  let res: Response;
  try {
    const central = () =>
      fetcher(`${base}/v1/briqs/${encodeURIComponent(id)}/exec`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        // A deadline for this call, past the command's own: the shared client's 30 s would cut a
        // command that has 60.
        signal: AbortSignal.timeout(input.timeoutMs + ROUND_TRIP_MS),
      });
    res = regional
      ? // The regional origin could not be connected to: nothing was sent, the API runs it.
        await regional.send(body).catch((error: unknown) => {
          if (error instanceof RegionalNotReached) return central();
          throw error;
        })
      : await central();
  } catch (error) {
    if (regional && error instanceof BriqApiError && error.code === 'regional_unavailable')
      throw fail('unavailable', 'Regional command access expired before dispatch');
    throw neverConnected(error)
      ? fail('unavailable', 'Briq command stream unavailable')
      : unconfirmed();
  }
  if (!res.ok && regional) {
    // No regional status currently proves that the command was never dispatched.
    res.body?.cancel().catch(() => {});
    throw unconfirmed();
  }
  if (!res.ok) {
    const said: Said = {};
    try {
      const text = await readLimited(res, MAX_REFUSAL_BYTES);
      const details = (
        JSON.parse(text ?? '') as { error?: { details?: { op?: unknown; providerSaid?: unknown } } }
      ).error?.details;
      // An operation name is words: letters, underscores, dots, spaces (`get machine`).
      if (typeof details?.op === 'string' && /^[a-z_. ]{1,32}$/.test(details.op))
        said.op = details.op;
      if (typeof details?.providerSaid === 'string')
        said.providerSaid = details.providerSaid.slice(0, 300);
    } catch {
      // not our envelope (a proxy's page): the status alone
    }
    throw refusal(res.status, res.headers, refusalCode(res.status, said));
  }
  let answer: unknown;
  try {
    const text = await readLimited(res, MAX_ANSWER_BYTES);
    // The command ended; the answer is more than anyone could read.
    if (text === undefined) throw fail('quota', 'Command output exceeds the adapter limit');
    answer = JSON.parse(text);
  } catch (error) {
    throw error instanceof BriqOperationError ? error : unconfirmed();
  }
  const r = answer as Record<string, unknown> | null;
  if (
    !r ||
    typeof r !== 'object' ||
    typeof r.stdout !== 'string' ||
    typeof r.stderr !== 'string' ||
    typeof r.timedOut !== 'boolean' ||
    !Number.isInteger(r.exitCode) ||
    (!r.timedOut && ((r.exitCode as number) < 0 || (r.exitCode as number) > 255)) ||
    (r.truncated !== undefined && typeof r.truncated !== 'boolean')
  )
    throw unconfirmed();
  // The provider dropped the rest of a stream (the API says so, and a provider that cannot says
  // nothing). The stream delivers all of it, and a caller counting on that is told, not handed a cut.
  if (r.truncated === true)
    throw fail(
      'quota',
      'Command output reached the HTTP limit; run it with output callbacks (the stream)',
    );
  // A collector that throws ends the call like it does on the WebSocket.
  try {
    if (r.stdout) input.onChunk({ stream: 'stdout', text: r.stdout });
    if (r.stderr) input.onChunk({ stream: 'stderr', text: r.stderr });
  } catch {
    throw fail('provider', 'Output callback failed; remote command has ended');
  }
  return { exitCode: r.timedOut ? null : (r.exitCode as number), timedOut: r.timedOut };
}
