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
    let pending = this.pending.get(id);
    if (!pending) {
      if (this.pending.size >= 64) throw unavailable();
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
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
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
    try {
      try {
        value = await discover(requestedCommands);
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
        value = await discover();
      }
    } catch (error) {
      if (
        error instanceof BriqApiError &&
        ([404, 405, 501].includes(error.status) ||
          (error.status === 503 && error.code === 'provider_error'))
      )
        return null;
      throw error;
    }
    return this.validate(id, value);
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
    } catch {
      this.invalidate(descriptor.briqId, descriptor.token);
      throw unknownOutcome();
    }
  }
}
