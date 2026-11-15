import { fail } from './native-errors.js';
export interface OutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}
export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
}
export interface Command {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * The caller reads output as it arrives (a progress callback, a terminal view). Default true:
   * the command runs over the WebSocket, which streams. False says `onChunk` only collects, so the
   * output may come once the command has ended and the SDK may use the plain HTTP route
   * instead.
   */
  live?: boolean;
  onChunk(chunk: OutputChunk): void;
}
export const bytes = (s: string) => Buffer.byteLength(s);
/** The bounds of the finite-input v1 transport; one set for both routes, so they refuse alike. */
export function validate(input: Command): void {
  const env = Object.entries(input.env);
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    input.timeoutMs > 3600000 ||
    input.cmd.length < 1 ||
    input.cmd.length > 256 ||
    !input.cmd[0] ||
    input.cmd.some((s) => s.includes('\0') || bytes(s) > 32768) ||
    input.cmd.reduce((n, s) => n + bytes(s), 0) > 131072 ||
    !input.cwd.startsWith('/') ||
    input.cwd.includes('\0') ||
    bytes(input.cwd) > 4096 ||
    env.length > 256 ||
    env.some(
      ([k, v]) =>
        !k ||
        k.includes('=') ||
        k.includes('\0') ||
        bytes(k) > 4096 ||
        v.includes('\0') ||
        bytes(v) > 32768,
    ) ||
    env.reduce((n, [k, v]) => n + bytes(k) + bytes(v), 0) > 131072 ||
    (input.stdin !== undefined && (input.stdin.includes('\0') || bytes(input.stdin) > 524288))
  )
    throw fail('invalid_argument', 'Command exceeds Briq finite-input stream bounds');
}
