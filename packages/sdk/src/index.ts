import type {
  Briq as BriqRecord,
  BriqSpecInput,
  EndpointProtocol,
  ExposeMode,
  ForkCopy,
  KeyPolicy,
  RecipeFields,
  SupportTopic,
} from '@briq/public';

export type { BriqRecord, BriqSpecInput, ForkCopy, KeyPolicy, RecipeFields };

export interface RunResult {
  briqs: BriqRecord[];
  outputs: Record<string, string>;
  recipe: string | null;
  costLine: string;
}
export interface ForkResult {
  briqs: BriqRecord[];
  /** What each fork got from its source, by fork id. */
  copied: Record<string, ForkCopy>;
  /** The recipe's outputs pointing at the forks (a `DATABASE_URL`). */
  outputs: Record<string, string>;
  stack: string;
  skipped: string[];
  /** A stack fork with `expose`: what could not be exposed yet. */
  warning?: string;
  costLine: string;
}
/** `POST /v1/stacks/up`: the stack file's content. */
export interface StackUpInput {
  /** The stack file (`briq.yaml`), YAML or JSON. */
  file: string;
  /** The stack to bring up instead of the file's `stack`. */
  stack?: string;
  /** Values of secrets the file names as `{ secret: NAME }`, by name; the others are generated. */
  secrets?: Record<string, string>;
  wait?: boolean;
  waitTimeoutMs?: number;
}
export interface StackUpResult {
  stack: string;
  /** Every briq of the file's services, in file order: made now, or there already. */
  briqs: BriqRecord[];
  /** The services this up made. */
  created: string[];
  /** The services the stack had: left as they are. */
  existing: string[];
  /** An endpoint the file asks for that could not be opened yet. */
  warnings?: string[];
  /** Connection strings, generated secrets, `<briq>:URL` per published service. */
  outputs: Record<string, string>;
  costLine: string;
}
interface ForkLifetimes {
  /** The fork's sleep (`"30m"`, `"3h"`, `"7d"`, `"never"`); the source's by default. */
  sleep?: string;
  wait?: boolean;
  waitTimeoutMs?: number;
}
/** An async exec: a command started in a briq and checked later. */
export interface Exec {
  id: string;
  briqId: string;
  cmd: string[];
  /** `running` until it ends: `exited` (see `exitCode`), `timed_out`, `stopped` or `lost`. */
  state: 'running' | 'exited' | 'timed_out' | 'stopped' | 'lost';
  exitCode: number | null;
  startedAt: string;
  deadlineAt: string;
  finishedAt: string | null;
  /** Where the whole output is, in the briq: `out` and `err`. */
  outputDir: string;
  /** False when the briq is not running: `state` is the last one seen, `output` is absent. */
  briqRunning: boolean;
  /** The last 64 KB of each stream and their whole sizes; absent when the briq is not running. */
  output?: { stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number };
}
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  costLine: string;
  /** Set when `timeoutMs` was over 60000 without async: it ran with 60000. */
  warning?: string;
}
export interface LogLine {
  ts: string;
  stream: 'stdout' | 'stderr';
  line: string;
}
export interface Quota {
  plan: string;
  policy: KeyPolicy;
  spentTodayCents: number;
  remainingTodayCents: number;
  creditBalanceCents: number;
  /** Live briqs this credential started: what `maxConcurrentBriqs` counts. */
  liveBriqs: number;
  /** Live briqs in the whole team, whoever started them. */
  teamLiveBriqs: number;
  remainingConcurrency: number;
  /** The longest `sleep` this credential may give, every limit taken; absent from an older API. */
  longestSleep?: string;
  /** Volume GB the team holds, stopped and failed briqs included, and its plan's most; absent from an older API. */
  diskGb?: number;
  maxDiskGb?: number;
  /** The team the call acts on; absent from an older API. */
  team?: { id: string; slug: string; name: string };
  /** The key or connected client (`oauth`) the call presents; null from a dashboard session. */
  key?: { id: string; kind: 'key' | 'oauth'; name: string } | null;
}
export interface RecipeSummary {
  name: string;
  title: string;
  description: string;
  tags: string[];
}
export interface RecipeParam {
  name: string;
  type: string;
  options: string[] | null;
  /** JSON of the default, when there is one. */
  defaultValue: string | null;
  required: boolean;
  description: string | null;
  /** The shape of a record or object value (absent from an older API). */
  format?: string | null;
}
export interface RecipeDetail extends RecipeSummary {
  /** The defaults a run gets when it sets no field. */
  params: Record<string, unknown>;
  /** Every field the recipe takes, optional ones included (absent from an older API). */
  parameters?: RecipeParam[];
  outputs: string[];
  briqs: Array<{ name: string; image: string; ports: number[] }>;
  /** The recipe's page for `briq_docs`, `cookbook/<name>` (absent from an older API). */
  docs?: string;
  /** Guides that walk through a task with it, as `briq_docs` names them (absent from an older API). */
  guides?: string[];
}
export type RunInput =
  | {
      spec: BriqSpecInput;
      stack?: string;
      /** Publish as it is created (`spec.expose`, or its only port); URL in outputs. */
      expose?: ExposeMode;
      wait?: boolean;
      waitTimeoutMs?: number;
    }
  | (RecipeFields & {
      /** A recipe; beside it, the fields of the service it makes (`RecipeFields`). */
      recipe: string;
      name?: string;
      stack?: string;
      /**
       * When every briq of the recipe goes to sleep: after this long without use, a string such as
       * `"30m"`, `"3h"`, `"7d"`, or `"never"` (always on). Default set by the service.
       */
      sleep?: string;
      /** Publish the recipe's front door as it is created; URL in outputs. Off by default. */
      expose?: ExposeMode;
      wait?: boolean;
      waitTimeoutMs?: number;
    });

/**
 * An id or a name as one path segment, whatever it contains. Ids reach this client from agents'
 * tool arguments; unencoded, `../keys` as a briq id asked for another route altogether.
 */
const seg = (value: string) => encodeURIComponent(value);

export class BriqApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    /** The API's id for the failed request (`x-request-id`): quote it when asking for help. */
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export interface BriqClientOptions {
  baseUrl?: string;
  /** Custom fetch, e.g. an in-process Hono `app.request` for tests or the hosted MCP server. */
  fetch?: typeof fetch;
}

/** Typed client over the briq REST API. One method per endpoint; the MCP tools and the CLI are built on it. */
export class Briq {
  private readonly baseUrl: string;
  private readonly f: typeof fetch;
  constructor(
    private readonly apiKey: string,
    opts: BriqClientOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.briq.cloud').replace(/\/$/, '');
    this.f = opts.fetch ?? fetch;
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const qs = query
      ? `?${Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')}`
      : '';
    const res = await this.f(`${this.baseUrl}${path}${qs}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // Not every answer is ours: a proxy in front of the API answers an outage with HTML.
    let json: Record<string, unknown> = {};
    try {
      if (text) json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new BriqApiError(
        res.status,
        'error',
        res.ok ? 'the API answered with something that is not JSON' : `HTTP ${res.status}`,
        undefined,
        res.headers.get('x-request-id') ?? undefined,
      );
    }
    if (!res.ok) {
      const e =
        (
          json as {
            error?: { code?: string; message?: string; details?: unknown; requestId?: string };
          }
        ).error ?? {};
      throw new BriqApiError(
        res.status,
        e.code ?? 'error',
        e.message ?? `HTTP ${res.status}`,
        e.details,
        res.headers.get('x-request-id') ?? e.requestId ?? undefined,
      );
    }
    return json as T;
  }

  run(input: RunInput) {
    return this.call<RunResult>('POST', '/v1/briqs', input);
  }
  list(opts: { stack?: string; all?: boolean } = {}) {
    return this.call<{ briqs: BriqRecord[]; costLine: string }>('GET', '/v1/briqs', undefined, {
      stack: opts.stack,
      all: opts.all ? 'true' : undefined,
    });
  }
  status(id: string) {
    return this.call<{ briq: BriqRecord; costLine: string }>('GET', `/v1/briqs/${seg(id)}`);
  }
  exec(id: string, cmd: string[], opts: { timeoutMs?: number; stdin?: string } = {}) {
    return this.call<ExecResult>('POST', `/v1/briqs/${seg(id)}/exec`, { cmd, ...opts });
  }
  /** Start a command and return at once: for anything that can take over a minute. */
  execAsync(id: string, cmd: string[], opts: { timeoutMs?: number; stdin?: string } = {}) {
    return this.call<{ exec: Exec; costLine: string }>('POST', `/v1/briqs/${seg(id)}/exec`, {
      cmd,
      ...opts,
      async: true,
    });
  }
  /** Where an async exec stands, with its output's tail; `waitMs` (45000 at most) waits for it to end. */
  execStatus(id: string, execId: string, opts: { waitMs?: number } = {}) {
    return this.call<{ exec: Exec; costLine: string }>(
      'GET',
      `/v1/briqs/${seg(id)}/execs/${seg(execId)}`,
      undefined,
      opts,
    );
  }
  /** Stop an async exec and everything it started. */
  execStop(id: string, execId: string) {
    return this.call<{ exec: Exec; costLine: string }>(
      'DELETE',
      `/v1/briqs/${seg(id)}/execs/${seg(execId)}`,
    );
  }
  /** A briq's async execs, newest first. */
  execs(id: string) {
    return this.call<{ execs: Exec[] }>('GET', `/v1/briqs/${seg(id)}/execs`);
  }
  logs(id: string, opts: { since?: string; limit?: number } = {}) {
    return this.call<{ lines: LogLine[]; next: string | null }>(
      'GET',
      `/v1/briqs/${seg(id)}/logs`,
      undefined,
      opts,
    );
  }
  putFile(id: string, path: string, contentBase64: string) {
    return this.call<{
      path: string;
      bytes: number;
      sha256: string;
      verified: boolean;
      warning?: string;
    }>('POST', `/v1/briqs/${seg(id)}/files`, {
      path,
      contentBase64,
    });
  }
  getFile(id: string, path: string) {
    return this.call<{ path: string; contentBase64: string }>(
      'GET',
      `/v1/briqs/${seg(id)}/files`,
      undefined,
      { path },
    );
  }
  /**
   * `mode` left out keeps the mode the briq's URL already has (`public` when it has none).
   * `rotate` gives a private URL a new token: links and cookies with the old one stop working.
   */
  expose(
    id: string,
    port: number,
    mode?: ExposeMode,
    opts: { rotate?: boolean; protocol?: EndpointProtocol } = {},
  ) {
    return this.call<{
      id: string;
      port: number;
      /** A database protocol: a TCP endpoint; absent or `http`: a URL. */
      protocol?: EndpointProtocol;
      mode: ExposeMode;
      url: string;
      hostname: string;
      /** A TCP endpoint: its connection string, TLS required (a recipe's has its password). */
      connectionString?: string;
      /** What the connection string cannot carry: a user, an API key. */
      credentials?: string;
      /** The machine restarted to deliver this port, or the URL moved here from another one. */
      warning?: string;
    }>('POST', `/v1/briqs/${seg(id)}/expose`, {
      port,
      ...(mode ? { mode } : {}),
      ...(opts.rotate ? { rotate: true } : {}),
      ...(opts.protocol ? { protocol: opts.protocol } : {}),
    });
  }
  stop(id: string) {
    return this.call<{ briq: BriqRecord }>('POST', `/v1/briqs/${seg(id)}/stop`);
  }
  start(id: string) {
    return this.call<{ briq: BriqRecord }>('POST', `/v1/briqs/${seg(id)}/start`);
  }
  destroy(id: string) {
    return this.call<{ briq: BriqRecord }>('DELETE', `/v1/briqs/${seg(id)}`);
  }
  /**
   * Change when a briq (or, with `stack: true`, every briq of its stack) goes to sleep: a string
   * such as `"30m"`, `"3h"`, `"7d"`, or `"never"` (always on). The briq asked for comes first.
   */
  setSleep(id: string, sleep: string, opts: { stack?: boolean } = {}) {
    return this.call<{ briqs: BriqRecord[] }>('POST', `/v1/briqs/${seg(id)}/sleep`, {
      sleep,
      ...opts,
    });
  }
  /** A new briq starting from a copy of this one's disk; the source is left as it is. */
  fork(id: string, opts: ForkLifetimes & { name?: string; stack?: string } = {}) {
    return this.call<ForkResult>('POST', `/v1/briqs/${seg(id)}/fork`, opts);
  }
  /**
   * Every briq of a stack, forked into a new stack under the same names. `expose` makes the fork
   * reachable from outside briq: outputs then name its endpoints.
   */
  forkStack(stack: string, opts: ForkLifetimes & { into?: string; expose?: ExposeMode } = {}) {
    return this.call<ForkResult>('POST', `/v1/stacks/${seg(stack)}/fork`, opts);
  }
  /** Destroy every briq of a stack; the empty stack stays. */
  destroyStack(stack: string) {
    return this.call<{
      stack: { id: string; name: string; createdAt: string };
      briqs: BriqRecord[];
    }>('DELETE', `/v1/stacks/${seg(stack)}`);
  }
  /**
   * Bring a stack up from its stack file: create the services it does not have, leave the others.
   * Never deletes.
   */
  up(input: StackUpInput) {
    return this.call<StackUpResult>('POST', '/v1/stacks/up', input);
  }
  stacks() {
    return this.call<{
      stacks: Array<{ id: string; name: string; createdAt: string }>;
    }>('GET', '/v1/stacks');
  }
  createStack(name: string) {
    return this.call<{ stack: { id: string; name: string } }>('POST', '/v1/stacks', { name });
  }
  recipes() {
    return this.call<{ recipes: RecipeSummary[] }>('GET', '/v1/recipes');
  }
  recipe(name: string) {
    return this.call<{ recipe: RecipeDetail }>('GET', `/v1/recipes/${seg(name)}`);
  }
  quota() {
    return this.call<Quota>('GET', '/v1/quota');
  }
  /** A bug, an idea or a question, emailed to the people who build briq. */
  feedback(input: { topic: SupportTopic; message: string }) {
    return this.call<{ ok: true; replyTo: string | null; receipt: boolean; requestId: string }>(
      'POST',
      '/v1/support',
      input,
    );
  }
  keys() {
    return this.call<{
      keys: Array<{
        id: string;
        name: string;
        prefix: string;
        policy: KeyPolicy;
        createdAt: string;
        revokedAt: string | null;
      }>;
    }>('GET', '/v1/keys');
  }
  revokeKey(id: string) {
    return this.call<{ ok: boolean }>('DELETE', `/v1/keys/${seg(id)}`);
  }
  audit(opts: { limit?: number; key?: string } = {}) {
    return this.call<{ events: Array<Record<string, unknown>> }>(
      'GET',
      '/v1/audit',
      undefined,
      opts,
    );
  }
}
