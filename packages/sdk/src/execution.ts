import type { AccessDescriptor } from '@briq/public';
import { BriqApiError } from './errors.js';

export interface ExecutionOptions {
  /** A separate transport for execution origins. Never reuse a control transport's credentials. */
  fetch?: typeof fetch;
  /** Command admissions to reserve together, 1–16. Unused admissions expire. Default: 4,
   * or 1 with a custom control fetch. Opting in with a custom fetch requires its credential
   * and team context to remain fixed for this client. */
  maxCommands?: number;
}

/**
 * Discovery is repeated only when the API cannot have issued anything: a connection that was never
 * made, a 429, or the API's own 503 refusal. A lost answer (a reset, a read timeout, a 502 or 504
 * from the edge) is not repeated, since the API may have issued a grant for it. A retryable failure is tried again, at most `DISCOVERY_ATTEMPTS` times in all, after these
 * waits, or after the `Retry-After` it carries when that is longer and at most `RETRY_AFTER_CAP_MS`.
 * Slowness is never a reason to go through the API: discovery waits for its answer (the transport
 * ends a call that gets none), and a briq goes there only when regional access is not available.
 */
const DISCOVERY_ATTEMPTS = 3;
const DISCOVERY_BACKOFF_MS = [250, 1000];
const RETRY_AFTER_CAP_MS = 5000;
/** How long a briq with no regional route goes through the API without asking again. Its
 * placement does not change by itself; a briq that is moved or recreated has another id. */
const NO_ROUTE_COOLDOWN_MS = 10 * 60_000;
/** How long a briq whose regional access was refused, or stayed unreachable after the retries,
 * goes through the API without asking again: a few commands in a row do not each repeat the
 * retries. A transient failure that a retry got past sets nothing. */
const FALLBACK_COOLDOWN_MS = 5000;
/** The most briqs tracked at once in each of the pending, cached and cooldown tables. */
const MAX_TRACKED = 1024;

/** What undici reports when no connection was made, so nothing of the command was sent. */
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
export const neverConnected = (error: unknown) => {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && NEVER_CONNECTED.has(code);
};

/** The regional origin could not be connected to: the request was never sent, so the command may
 * go through the API. Nothing else that goes wrong after `send` starts is ever this. */
export class RegionalNotReached extends Error {
  constructor() {
    super('the regional execution origin could not be reached; the command was not sent');
  }
}

/** The wait before discovery attempt `attempt + 1`, or undefined when the failure is not retried. */
function retryDelay(error: unknown, attempt: number): number | undefined {
  if (attempt >= DISCOVERY_ATTEMPTS) return undefined;
  let after: number | undefined;
  if (error instanceof BriqApiError) {
    if (error.status !== 429 && error.status !== 503) return undefined;
    after = error.retryAfterSeconds === undefined ? undefined : error.retryAfterSeconds * 1000;
  } else if (!neverConnected(error)) return undefined;
  const backoff = DISCOVERY_BACKOFF_MS[attempt - 1] ?? 1000;
  if (after === undefined) return backoff;
  return after > RETRY_AFTER_CAP_MS ? undefined : Math.max(backoff, after);
}

function unavailable() {
  return new BriqApiError(503, 'regional_unavailable', 'regional execution is unavailable');
}

export function unknownOutcome(requestId?: string) {
  return new BriqApiError(
    503,
    'outcome_unknown',
    'the command may have run; it was not sent again',
    undefined,
    requestId,
  );
}

/** Credentials stay within this client's bounded, expiry-aware memory cache. */
export class ExecutionRouter {
  private readonly transport: typeof fetch | undefined;
  private readonly maxCommands: number;
  private legacyDiscovery = false;
  private createAccessRefused = false;
  private readonly cooldown = new Map<string, number>();
  private readonly cache = new Map<string, { descriptor: AccessDescriptor; remaining: number }>();
  private readonly pending = new Map<string, Promise<AccessDescriptor | null>>();

  constructor(options: ExecutionOptions | undefined, customControl: boolean) {
    this.transport = options?.fetch ?? (customControl ? undefined : globalThis.fetch);
    this.maxCommands = options?.maxCommands ?? (customControl ? 1 : 4);
    if (!Number.isSafeInteger(this.maxCommands) || this.maxCommands < 1 || this.maxCommands > 16)
      throw new TypeError('execution maxCommands must be an integer from 1 to 16');
  }

  invalidate(id: string, token: string) {
    if (this.cache.get(id)?.descriptor.token === token) this.cache.delete(id);
  }

  private take(id: string): AccessDescriptor | null {
    const cached = this.cache.get(id);
    if (!cached) return null;
    if (Date.parse(cached.descriptor.expiresAt) <= Date.now() + 1000) {
      this.cache.delete(id);
      return null;
    }
    if (--cached.remaining === 0) this.cache.delete(id);
    return cached.descriptor;
  }

  async access(
    id: string,
    discover: (maxCommands?: number) => Promise<unknown>,
  ): Promise<AccessDescriptor | null> {
    if (!this.transport) return null;
    const cached = this.take(id);
    if (cached) return cached;
    if ((this.cooldown.get(id) ?? 0) > Date.now()) return null;
    let pending = this.pending.get(id);
    if (!pending) {
      // Past the bound the briq goes through the API: nothing is dropped or refused.
      if (this.pending.size >= MAX_TRACKED) return null;
      pending = this.discover(id, discover)
        .then((descriptor) => {
          if (descriptor) this.store(id, descriptor);
          return descriptor;
        })
        .finally(() => this.pending.delete(id));
      this.pending.set(id, pending);
    }
    if (!(await pending)) return null;
    // Concurrent callers claim distinct reserved units synchronously before sending.
    return this.take(id) ?? this.access(id, discover);
  }

  private store(id: string, descriptor: AccessDescriptor) {
    // Eviction only burns unused reservations; it never replenishes their authority.
    for (const [key, value] of this.cache)
      if (Date.parse(value.descriptor.expiresAt) <= Date.now() + 1000) this.cache.delete(key);
    if (this.cache.size >= MAX_TRACKED) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, { descriptor, remaining: descriptor.maxCommands ?? 1 });
  }

  /**
   * What a create sends to get the first command's access with its answer: the body of
   * `POST /v1/briqs/{id}/access`. Nothing when commands go through the control API anyway.
   */
  accessRequest(): { version: 1; operations: ['exec']; maxCommands?: number } | undefined {
    if (!this.transport || this.createAccessRefused) return undefined;
    return {
      version: 1,
      operations: ['exec'],
      ...(this.legacyDiscovery || this.maxCommands === 1 ? {} : { maxCommands: this.maxCommands }),
    };
  }

  /** An API that refused `access` on a create: stop sending it. */
  noCreateAccess() {
    this.createAccessRefused = true;
  }

  /**
   * Keep the access a create answered with (`access`, by briq id), under the key `access()`
   * uses, after the same checks. Anything invalid is dropped: the first command asks for its own.
   */
  /** Keeps the grants of `ids` only: an answer cannot hand over access to a briq it did not create. */
  seed(access: unknown, ids: readonly string[]) {
    if (!this.transport) return;
    if (!access || typeof access !== 'object') return;
    for (const [id, value] of Object.entries(access)) {
      if (!ids.includes(id)) continue;
      try {
        this.store(id, this.validate(id, value));
      } catch {}
    }
  }

  private async discover(
    id: string,
    discover: (maxCommands?: number) => Promise<unknown>,
  ): Promise<AccessDescriptor | null> {
    let value: unknown;
    const requestedCommands =
      this.legacyDiscovery || this.maxCommands === 1 ? undefined : this.maxCommands;
    // No command has been sent while access is discovered, so a failure that is not got past (a
    // refusal, no route, a gateway that stays down) leaves the command to the API route, which
    // answers for itself: a key it refuses it refuses there too. Only an invalid descriptor is an error.
    try {
      try {
        value = await this.retrying(() => discover(requestedCommands));
      } catch (error) {
        // An older API rejects the additional discovery field before admission. No command
        // has been sent. Authentication, policy, quota and transport failures never negotiate.
        if (
          requestedCommands === undefined ||
          !(error instanceof BriqApiError) ||
          error.status !== 400 ||
          error.code !== 'validation'
        )
          throw error;
        this.legacyDiscovery = true;
        value = await this.retrying(() => discover());
      }
    } catch (error) {
      const noRoute = error instanceof BriqApiError && error.code === 'no_regional_route';
      this.holdOff(id, noRoute ? NO_ROUTE_COOLDOWN_MS : FALLBACK_COOLDOWN_MS);
      return null;
    }
    return this.validate(id, value);
  }

  /** Runs one discovery call, again after a retryable failure, within the attempt and wait bounds. */
  private async retrying<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const wait = retryDelay(error, attempt);
        if (wait === undefined) throw error;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  /** Sends the briq's commands through the API, without asking for regional access, for `ms`. */
  private holdOff(id: string, ms: number) {
    this.cooldown.delete(id);
    this.cooldown.set(id, Date.now() + ms);
    if (this.cooldown.size > MAX_TRACKED) this.cooldown.delete(this.cooldown.keys().next().value!);
  }

  private validate(id: string, value: unknown): AccessDescriptor {
    const descriptor = value as Partial<AccessDescriptor> | null;
    let origin: URL | undefined;
    try {
      origin = new URL(descriptor?.origin ?? '');
    } catch {}
    if (
      !descriptor ||
      descriptor.version !== 1 ||
      descriptor.briqId !== id ||
      typeof descriptor.region !== 'string' ||
      !descriptor.region ||
      !origin ||
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      descriptor.origin !== origin.origin ||
      !Array.isArray(descriptor.operations) ||
      descriptor.operations.length !== 1 ||
      descriptor.operations[0] !== 'exec' ||
      !Array.isArray(descriptor.transports) ||
      descriptor.transports.length !== 1 ||
      descriptor.transports[0] !== 'http' ||
      typeof descriptor.token !== 'string' ||
      !descriptor.token ||
      descriptor.token.length > 16_384 ||
      /\s/.test(descriptor.token) ||
      typeof descriptor.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(descriptor.expiresAt)) ||
      Date.parse(descriptor.expiresAt) <= Date.now() + 1000 ||
      Date.parse(descriptor.expiresAt) > Date.now() + 65_000 ||
      typeof descriptor.routeGeneration !== 'string' ||
      !descriptor.routeGeneration ||
      (descriptor.maxCommands !== undefined &&
        (!Number.isSafeInteger(descriptor.maxCommands) ||
          descriptor.maxCommands < 1 ||
          descriptor.maxCommands > this.maxCommands))
    )
      throw new BriqApiError(502, 'invalid_access', 'the API returned invalid execution access');
    return descriptor as AccessDescriptor;
  }

  async send(descriptor: AccessDescriptor, path: string, body: unknown): Promise<Response> {
    // No command was sent when the credential expires while preparing its request.
    if (Date.parse(descriptor.expiresAt) <= Date.now() + 1000) throw unavailable();
    try {
      const init = {
        method: 'POST',
        headers: {
          authorization: `Bearer ${descriptor.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        credentials: 'omit' as const,
        redirect: 'error' as const,
        cache: 'no-store' as const,
        referrerPolicy: 'no-referrer' as const,
        // Covers the bounded regional operation envelope and response transport.
        signal: AbortSignal.timeout(95_000),
      };
      const response = await this.transport!(`${descriptor.origin}${path}`, init);
      if (!response.ok) this.invalidate(descriptor.briqId, descriptor.token);
      return response;
    } catch (error) {
      this.invalidate(descriptor.briqId, descriptor.token);
      // No connection was made: nothing of the command was sent, so the API may run it. Anything
      // after the request may have left is unknown, and never repeated.
      if (neverConnected(error)) {
        this.holdOff(descriptor.briqId, FALLBACK_COOLDOWN_MS);
        throw new RegionalNotReached();
      }
      throw unknownOutcome();
    }
  }
}
