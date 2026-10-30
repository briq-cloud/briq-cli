import { z } from 'zod';
import { refsIn } from './refs.js';
import { Size } from './sizes.js';
import { Sleep } from './sleep.js';

/**
 * DNS-safe name: lowercase, digits, single dashes between runs, 1-32 chars. At most 32, so a
 * briq name and a short suffix fit one hostname label.
 */
export const DnsName = z
  .string()
  .min(1)
  .max(32)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'must be lowercase letters, digits and single dashes between them',
  );

export const ImageRef = z
  .string()
  .min(3)
  .max(255)
  .regex(
    /^[a-z0-9][a-z0-9._\/-]*(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/,
    'invalid OCI image reference',
  );

/**
 * `creating`, `stopping`, `starting` and `destroying` are on their way to `running`, `stopped`,
 * `running` and `destroyed`. Asking for the same move again while one is in flight waits for it
 * instead of starting a second one. `sleeping`: stopped after its `sleep` without use, and woken by
 * the next use; `stopped` waits for `briq_start`. `resizing`: getting another size or a bigger
 * volume, then back to `running` (restarted for a new size) or to where it was stopped. `moving`: going
 * into another stack or out of it, then back where it was (restarted when it joins a stack that
 * already has briqs).
 */
export const BriqState = z.enum([
  'creating',
  'running',
  'stopping',
  'stopped',
  'sleeping',
  'starting',
  'resizing',
  'moving',
  'destroying',
  'destroyed',
  'error',
]);
export type BriqState = z.infer<typeof BriqState>;

/**
 * Why a briq is stopped. `idle` and `provider` are stops nobody asked for that changed nothing
 * about the briq: it is asleep, and the next call or visit wakes it. `cap` and `credits` are
 * limits: the briq sleeps again once the limit has cleared (the next UTC day for a key's spend
 * cap, a top-up for credits). `user` is someone's `briq_stop`. `exited` is the briq's own process
 * ending (a crash, a command that ran to completion): starting it again would only repeat that,
 * so it stays stopped until someone fixes the cause and calls start.
 */
export const StopReason = z.enum(['idle', 'cap', 'credits', 'user', 'provider', 'exited']);
export type StopReason = z.infer<typeof StopReason>;
/**
 * The last time a briq's main process ended on its own: not stopped by briq, but exited or killed.
 * The provider restarts a failing process a few times before giving up, so a briq can be running
 * and still have one of these from a moment ago.
 */
export const ProcessExit = z.object({
  /** The exit status; 128 + n for a process killed by signal n. */
  code: z.number().int(),
  /** Killed for using more memory than its size has. */
  oomKilled: z.boolean(),
  at: z.string().datetime(),
});
export type ProcessExit = z.infer<typeof ProcessExit>;

/**
 * An environment variable name, as images use them: `PGDATA`, `http_proxy`, `discovery.type`.
 * Never `=`, a space or a control character, which a container runtime would read as something
 * else or refuse halfway through a create.
 */
export const EnvName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, 'must be a variable name: letters, digits, _ . -');

/** Bounds on what a spec may carry: it is returned with the briq in every list. */
export const MAX_ENV_VALUE = 32_768;
const MAX_ENV_VARS = 100;
const MAX_ARGS = 64;
const MAX_ARG = 8_192;
const Argv = z.array(z.string().max(MAX_ARG)).max(MAX_ARGS);

/**
 * A command: a string, run with `sh -c` (`npm start`, `a && b`), or the argv itself. Where a
 * service takes its command from a person or an agent, as a GitHub Actions step takes `run`.
 */
export const Command = z.union([z.string().min(1).max(MAX_ARG), Argv]);
export type Command = z.infer<typeof Command>;

/** A command as the argv a container runs. */
export const toArgv = (c: Command): string[] => (typeof c === 'string' ? ['sh', '-c', c] : c);

/**
 * A plain value, or a secret: write-only, stored encrypted, masked in status, logs and audit.
 * `{ secret: NAME }` alone has briq generate the value; `{ secret: NAME, value }` stores one the
 * caller has (a password from another service). Either way the spec keeps only `{ secret: NAME }`,
 * and its `scope` when it has one.
 *
 * `scope: "boot"` keeps the secret out of the machine's environment, which every `briq_exec`
 * inherits. It reaches the briq as a file the recipe's boot script reads for its steps (a clone,
 * an install from a private registry) and deletes before the process starts: the code, and any
 * command run later, cannot read it. Only a recipe with a boot script takes one (the language
 * recipes, the sandbox); an image's own command has nothing that reads the file.
 *
 * `hosts` makes a secret of this briq's own that it never holds: the value is given here and
 * stored for this briq, its environment gets a placeholder, and the team's credential gateway
 * puts the real value into its outbound requests to those hosts, in `locations` (request headers
 * unless said otherwise; `"body"` for a form or JSON field). For code that runs in a sandbox and
 * calls an API with a credential.
 *
 * `scope: "team"` names a team secret (`POST /v1/secrets`, the dashboard's Secrets page), added
 * once for every briq of the team, with its hosts: the same placeholder and gateway, the value
 * never given here.
 */
/** A host a secret may be sent to: `api.github.com`, or `*.example.com` for its subdomains. */
export const SecretHost = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i,
    'a host name (api.github.com), or *.example.com for every subdomain',
  )
  .transform((h) => h.toLowerCase());

/** Where in a request the placeholder is replaced: request headers, the body, or both. */
export const SecretLocation = z.enum(['header', 'body']);
export type SecretLocation = z.infer<typeof SecretLocation>;

export const EnvValue = z.union([
  z.string().max(MAX_ENV_VALUE),
  z
    .object({
      secret: EnvName,
      value: z
        .string()
        .max(MAX_ENV_VALUE)
        // A reference is resolved from the stored spec (forks, the order a stack starts in), which
        // never holds the value: put the address in a plain variable.
        .refine((v) => refsIn([v]).length === 0, {
          message:
            'a secret value cannot hold a {{briq:…}} reference: put the address in a plain variable',
        })
        .optional(),
      scope: z.enum(['boot', 'team']).optional(),
      hosts: z.array(SecretHost).min(1).max(20).optional(),
      locations: z.array(SecretLocation).min(1).optional(),
    })
    .strict(),
]);
export type EnvValue = z.infer<typeof EnvValue>;
/** A secret in env, as a marker (`{ secret }`) or with its value. */
export type EnvSecret = Exclude<EnvValue, string>;
/** A secret that must never be in the machine's environment: the boot steps' only. */
export const isBootSecret = (v: EnvValue | undefined): v is EnvSecret & { scope: 'boot' } =>
  typeof v === 'object' && v !== null && v.scope === 'boot';
/** A team secret the credential gateway puts in: the briq holds a placeholder. */
export const isTeamSecret = (v: EnvValue | undefined): v is EnvSecret & { scope: 'team' } =>
  typeof v === 'object' && v !== null && v.scope === 'team';
/** A secret of the briq's own that the credential gateway puts in (`hosts`): a placeholder too. */
export const isProxiedSecret = (v: EnvValue | undefined): v is EnvSecret & { hosts: string[] } =>
  typeof v === 'object' && v !== null && Array.isArray(v.hosts) && v.hosts.length > 0;
/** A secret that reaches the briq as a placeholder and the destination as the value. */
export const viaCredentialGateway = (v: EnvValue | undefined) =>
  isTeamSecret(v) || isProxiedSecret(v);

/** A volume's size when the spec does not say: small, since a team's plan bounds the disk it holds. */
export const DEFAULT_VOLUME_GB = 2;

export const VolumeSpec = z.object({
  mount: z.string().startsWith('/').max(255),
  gb: z.number().int().min(1).max(500).default(DEFAULT_VOLUME_GB),
  /**
   * `never`: what is on this volume stays on it. A fork of the briq is refused and the provider
   * keeps no backup of it. For a volume that holds sign-ins, which a copy would let two machines
   * use at once.
   */
  copy: z
    .literal('never')
    .optional()
    .describe(
      '"never": no fork of the briq and no backup of the volume, for one that holds sign-ins',
    ),
});

/** Ports a spec may declare. Exposing a port it does not declare adds it, up to this. */
export const MAX_SPEC_PORTS = 32;

/** Boot files a spec may carry, in all: what a small app's sources need, not its data. */
export const MAX_SPEC_FILES = 64;
export const MAX_SPEC_FILES_BYTES = 256 * 1024;

/** An absolute path, without `..` or empty segments: where a boot file is written. */
export const FilePath = z
  .string()
  .max(255)
  .regex(/^\/(?:[^/\0]+\/)*[^/\0]+$/, 'must be an absolute path to a file, like /app/server.py')
  .refine((p) => !p.split('/').includes('..') && !p.split('/').includes('.'), {
    message: 'must not contain . or .. segments',
  });

/**
 * Why `s` is not padded base64, or undefined when it is. Agents write base64 out token by token,
 * and a long one cut short still looks like base64: its length is what gives it away, so it is
 * refused here rather than written and found broken by the program that reads it.
 */
export function base64Problem(s: string): string | undefined {
  const bad = /[^A-Za-z0-9+/=]/.exec(s);
  if (bad)
    return `contains ${JSON.stringify(bad[0])} at position ${bad.index}, which base64 does not use`;
  const pad = s.indexOf('=');
  if (pad !== -1 && !/^={1,2}$/.test(s.slice(pad)))
    return `has padding (=) at position ${pad}, before its end`;
  if (s.length % 4 !== 0)
    return `is ${s.length} characters, not a multiple of 4: it was cut short on its way here (send it again in full), or its = padding is missing`;
  return undefined;
}

/** A boot file's content: text as it is (UTF-8), or `{ base64 }` for anything binary. */
export const FileContent = z.union([
  z.string(),
  z.object({
    base64: z.string().superRefine((s, ctx) => {
      const problem = base64Problem(s);
      if (problem) ctx.addIssue({ code: 'custom', message: `base64 ${problem}` });
    }),
  }),
]);
export type FileContent = z.infer<typeof FileContent>;

/** The bytes of a boot file's content. */
export const fileBytes = (c: FileContent): number =>
  typeof c === 'string'
    ? new TextEncoder().encode(c).length
    : Math.floor((c.base64.length * 3) / 4) - (c.base64.match(/=*$/)?.[0].length ?? 0);

export const Healthcheck = z.object({
  cmd: Argv.min(1),
  intervalMs: z.number().int().min(500).default(2000),
  // Per attempt, five minutes at most. A process still up when it runs out is waited for again,
  // three attempts in all, before the create fails.
  timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
});

export const BriqSpec = z.object({
  name: DnsName,
  image: ImageRef,
  cmd: Command.transform(toArgv)
    .optional()
    .describe(
      'The command: a string, run with sh -c ("npm start"), or the argv. Default: the image\'s',
    ),
  entrypoint: Argv.optional(),
  env: z
    .record(EnvName, EnvValue)
    .refine((env) => Object.keys(env).length <= MAX_ENV_VARS, {
      message: `at most ${MAX_ENV_VARS} environment variables`,
    })
    .default({})
    .describe(
      'A string; { secret: NAME } for a value briq generates; { secret: NAME, value } for a credential you have, stored encrypted and never returned. Plain values are shown in status. {{briq:NAME}} in a plain value becomes the address of briq NAME in the stack; {{self:host}}, the hostname of its own URL when it is published as it is created (localhost without one)',
    ),
  ports: z
    .array(z.number().int().min(1).max(65535))
    .max(MAX_SPEC_PORTS)
    .default([])
    .describe('The ports the image listens on'),
  size: Size.default('small'),
  volume: VolumeSpec.optional(),
  /**
   * Files written into the briq before its process starts, path → content: an app's sources,
   * a config file. What a command that reads them needs from its first second, which a file
   * uploaded after the start cannot be. Written again from here whenever the process starts over
   * (a restart, a cold start), so the spec is their source of truth: an edit made inside the briq
   * lasts until then. A resume from a memory snapshot is not a start over: the process carries on,
   * and so does its disk.
   * At most `MAX_SPEC_FILES` files and `MAX_SPEC_FILES_BYTES` in all; fetch anything bigger from
   * inside the briq (git clone, curl).
   */
  files: z
    .record(FilePath, FileContent)
    .refine((f) => Object.keys(f).length <= MAX_SPEC_FILES, {
      message: `at most ${MAX_SPEC_FILES} files`,
    })
    .refine((f) => Object.values(f).reduce((n, c) => n + fileBytes(c), 0) <= MAX_SPEC_FILES_BYTES, {
      message: `at most ${MAX_SPEC_FILES_BYTES / 1024} KB of files in all: fetch bigger ones from inside the briq (git clone, curl)`,
    })
    .optional()
    .describe(
      `Boot files, absolute path → text or { base64 }: written before the process starts and again whenever it starts over. At most ${MAX_SPEC_FILES} files and ${MAX_SPEC_FILES_BYTES / 1024} KB in all`,
    ),
  healthcheck: Healthcheck.optional(),
  /**
   * When the briq goes to sleep: after this long with no use (agent calls on any briq of its
   * stack, visits to any URL of its stack), or `"never"`. See `Sleep`. The default is
   * briq.cloud's; another environment may set its own.
   */
  sleep: Sleep.default('1h'),
  /**
   * The port a person is meant to reach, when this briq is the stack's front door.
   *
   * Declaring it is not exposing it: `briq_run({ expose })` and `briq_expose` still have to
   * ask. It says *which* briq and port a public URL points at, so a recipe can state that its
   * dashboard is the way in and its database is not. Publishing it restarts nothing.
   */
  expose: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .optional()
    .describe(
      'The port a public URL delivers to, when the briq has several: its front door. Declaring it publishes nothing',
    ),
});
export type BriqSpec = z.infer<typeof BriqSpec>;
export type BriqSpecInput = z.input<typeof BriqSpec>;

/**
 * What a recipe run may set, beside `recipe`: the fields of a service, as a GitHub Actions service
 * or job takes them, never params of the recipe's own. Each recipe checks the ones it takes
 * (`GET /v1/recipes/{name}`); this shape is what the API and MCP describe.
 */
export const RecipeFields = z.object({
  image: ImageRef.optional().describe(
    "Another tag (postgres:17) or a compatible image (pgvector/pgvector:pg16). Default: the recipe's",
  ),
  env: z
    .record(EnvName, EnvValue)
    .optional()
    .describe(
      "Added to the recipe's env, or replacing one of its values: a string, or { secret: NAME, value } for a credential",
    ),
  cmd: Command.optional().describe(
    'The command: a string run with sh -c ("npm start"), or the argv. A language recipe\'s start command',
  ),
  size: Size.optional(),
  volume: z
    .object({ gb: z.number().int().min(1).max(500) })
    .optional()
    .describe('The volume: { gb }'),
  files: z
    .record(z.string(), FileContent)
    .optional()
    .describe("Files, path → text or { base64 }: an app's code for a language recipe"),
  ports: z
    .array(z.number().int().min(1).max(65535))
    .optional()
    .describe('A language recipe: the port the app listens on, [8080] by default'),
  checkout: z
    .object({
      repo: z.string(),
      ref: z.string().optional(),
      path: z.string().optional(),
      token: z.object({ secret: EnvName, value: z.string().optional() }).optional(),
    })
    .optional()
    .describe(
      'A language or static recipe: the code from a repo, as actions/checkout. { repo: "github.com/owner/app", ref?, path?, token? }',
    ),
  steps: z
    .array(z.object({ run: z.string() }))
    .optional()
    .describe(
      'A language recipe: shell commands run before the app starts, as GitHub Actions steps. [{ run: "npm ci" }, { run: "npm run build" }]',
    ),
  routes: z
    .record(z.string(), z.string())
    .optional()
    .describe('The nginx recipe: path prefix → "briq:port", e.g. { "/api/": "backend:8080" }'),
});
export type RecipeFields = z.infer<typeof RecipeFields>;

/**
 * Who can open a briq's URL: `"public"` anyone, `"private"` only whoever has the URL, which
 * carries a secret checked before a request reaches the briq. A run left without one publishes
 * nothing; `briq_expose` can do it later.
 */
export const ExposeMode = z.enum(['public', 'private']);
export type ExposeMode = z.infer<typeof ExposeMode>;

/**
 * What an endpoint speaks. `http`: a URL. A database protocol: a TCP endpoint, a hostname under
 * `tcp.<domain>` served over TLS on the protocol's usual port. The caller names it; nothing is
 * inferred from the image.
 */
export const EndpointProtocol = z.enum([
  'http',
  'postgres',
  'mysql',
  'redis',
  'mongodb',
  'amqp',
  'bolt',
  'grpc',
]);
export type EndpointProtocol = z.infer<typeof EndpointProtocol>;

export const Endpoint = z.object({
  id: z.string(),
  port: z.number().int(),
  protocol: EndpointProtocol.default('http').describe(
    'http: a URL; a database protocol (postgres, mysql, redis, mongodb, amqp, bolt, grpc): a TCP endpoint, reachable from outside over TLS, url is its address without the password',
  ),
  mode: ExposeMode.describe(
    'public: anyone can open the URL; private: only whoever has the URL, which carries a secret checked before a request reaches the briq',
  ),
  url: z.string().url(),
});
export type Endpoint = z.infer<typeof Endpoint>;

/** Days a briq stays in `error` before it is destroyed on its own, kept for its logs and its error. */
export const ERRORED_KEEP_DAYS = 7;

export const Briq = z.object({
  id: z.string(),
  teamId: z.string(),
  stackId: z.string(),
  name: DnsName,
  image: ImageRef,
  size: Size,
  state: BriqState,
  internalHost: z.string().describe("Its address on the team's private network"),
  endpoints: z
    .array(Endpoint)
    .describe('Its URL, once published (one at most), and its TCP endpoint, once published'),
  /** Ports the image listens on, as declared in the spec. */
  ports: z.array(z.number().int()).default([]),
  /** Database ports its recipe declares, and the protocol each speaks: what to pass `briq_expose`. */
  databasePorts: z
    .array(z.object({ port: z.number().int(), protocol: EndpointProtocol }))
    .default([])
    .describe("Its recipe's database ports: briq_expose one with its protocol for a TCP endpoint"),
  /** The port meant to be reached from outside, when the spec names one. See `BriqSpec.expose`. */
  expose: z.number().int().nullable().default(null),
  /** Env as declared: plain values and `{ secret: NAME }` markers. Secret values never appear here. */
  env: z
    .record(EnvValue)
    .default({})
    .describe(
      'As declared: plain values, and { secret: NAME } for secrets, whose values never appear',
    ),
  createdAt: z.string().datetime(),
  startedAt: z
    .string()
    .datetime()
    .nullable()
    .describe('When its current run started (its last run, while it is not running)'),
  sleep: Sleep,
  sleepsAt: z
    .string()
    .datetime()
    .nullable()
    .describe(
      'When it goes to sleep unless it is used before then: every use moves this later. Null when it is not running or never sleeps',
    ),
  /** Last use: an agent call on its stack, or traffic to its stack's URLs. Drives `sleepsAt`. */
  lastUsedAt: z.string().datetime().nullable(),
  costCentsSoFar: z.number().describe('Euro cents billed so far, fractions of a cent included'),
  error: z.string().nullable(),
  /** When a briq in `error` is destroyed on its own: `ERRORED_KEEP_DAYS` after it got there. */
  destroysAt: z
    .string()
    .datetime()
    .nullable()
    .default(null)
    .describe('When a briq in error is destroyed automatically; null in any other state'),
  /** Why it is stopped or sleeping, while it is. See `StopReason`. */
  stoppedReason: StopReason.nullable()
    .default(null)
    .describe(
      'Why it is stopped or sleeping. idle and provider: asleep, the next call or visit wakes it. cap and credits: a limit, asleep again once it has cleared. user and exited: only briq_start runs it again',
    ),
  /** The last time its process exited on its own; `briq_logs` says why. See `ProcessExit`. */
  lastExit: ProcessExit.nullable()
    .default(null)
    .describe(
      'The last time its process ended on its own: exit code (128 + n for signal n), whether it ran out of memory, and when',
    ),
  /** Its boot files (`BriqSpec.files`): written before the process starts, and whenever it starts over. */
  files: z
    .array(z.object({ path: z.string(), bytes: z.number().int() }))
    .default([])
    .describe('Its boot files, by path and size; their content is not returned'),
  /** The briq this one was forked from, when it is a fork. See `ForkCopy`. */
  forkedFrom: z.string().nullable().default(null),
  /** Its volume, when it has one: kept until the briq is destroyed, grown by a resize. */
  volume: z
    .object({ mount: z.string(), gb: z.number().int() })
    .nullable()
    .default(null)
    .describe('Its volume: where it is mounted and its size in GB; null without one'),
});
export type Briq = z.infer<typeof Briq>;

/**
 * What a fork carries over from its source, strongest first.
 *
 * - `memory`: the running processes too, so the fork resumes where the source was. Not offered
 *   today.
 * - `disk`: the volume, block for block, as it was at the moment of the fork. Processes in the fork
 *   start fresh on that disk, the way they would after a power cut: a database replays its log.
 * - `config`: image, command, env and secrets only. What a briq without a volume gets, since
 *   nothing it wrote outside a volume is kept anywhere a fork could copy it from.
 */
export const ForkCopy = z.enum(['memory', 'disk', 'config']);
export type ForkCopy = z.infer<typeof ForkCopy>;
