import { BriqApiError } from './errors.js';
export type OperationCode =
  | 'auth'
  | 'not_found'
  | 'file_not_found'
  | 'quota'
  | 'unavailable'
  | 'invalid_argument'
  | 'provider'
  | 'outcome_unknown'
  | 'aborted'
  | 'timeout'
  | 'unsupported';
export class BriqOperationError extends Error {
  constructor(
    public readonly code: OperationCode,
    message: string,
    /** Set on a rate-limit refusal (429): seconds until the window the API counts in ends. */
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'BriqOperationError';
  }
}
export const fail = (code: OperationCode, message: string, retryAfterSeconds?: number) =>
  new BriqOperationError(code, message, retryAfterSeconds);

/** A request id worth repeating in an error: the API's own, shaped as ours. */
export const requestIdOf = (value: string | null | undefined) =>
  value && /^[\w.-]{1,64}$/.test(value) ? value : undefined;

/** `Retry-After` as seconds (the API sends whole seconds, up to a window of a minute). */
export const retryAfterOf = (value: string | null | undefined) => {
  const n = value && /^\d{1,4}$/.test(value) ? Number(value) : undefined;
  return n && n > 0 ? n : undefined;
};

/**
 * A command the API refused before it ran, for both routes (the WebSocket upgrade, the plain
 * HTTP call): the code by status, a 429 with the wait it asks, the sanitized text.
 */
export function refusal(
  status: number,
  headers: { get(name: string): string | null },
  code: OperationCode = statusCode(status),
) {
  const wait = status === 429 ? retryAfterOf(headers.get('retry-after')) : undefined;
  const request = status >= 500 ? requestIdOf(headers.get('x-request-id')) : undefined;
  return fail(
    code,
    `Briq command ${code === 'outcome_unknown' ? 'failed' : 'refused'} (${code})${wait ? `; retry in ${wait}s` : ''}${request ? `; request ${request}` : ''}`,
    wait,
  );
}
export function statusCode(status: number): OperationCode {
  return status === 401 || status === 403
    ? 'auth'
    : status === 404
      ? 'not_found'
      : status === 402 || status === 429 || status === 507
        ? 'quota'
        : status >= 500
          ? 'unavailable'
          : status === 400 || status === 422
            ? 'invalid_argument'
            : 'provider';
}
export async function safe<T>(operation: () => Promise<T>, file = false): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BriqOperationError) throw error;
    let code = error instanceof BriqApiError ? statusCode(error.status) : 'unavailable';
    if (file && code === 'not_found') code = 'file_not_found';
    throw fail(code, `Briq request failed (${code})`);
  }
}
