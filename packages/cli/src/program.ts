import { readFileSync, writeFileSync } from 'node:fs';
import {
  type EndpointProtocol,
  type ExposeMode,
  type FileContent,
  type SupportTopic,
  formatMoney,
  slugify,
} from '@briq/public';
import { Briq, BriqApiError, type Exec, type Quota, type RunInput } from '@briq/sdk';
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import {
  type StoredCredential,
  apiUrlOf,
  environmentOf,
  loadConfig,
  normalizeUrl,
  saveConfig,
} from './config.js';
import { writeEnv } from './envfile.js';
import { CliError, EXIT, notSignedIn, usage } from './errors.js';
import { discover, pollForTokens, register, requestCode } from './oauth.js';
import { VERSION, cliFetch, openSession } from './session.js';
import { registerUp } from './up.js';

/**
 * The CLI: one command per MCP tool (`briq_exec` → `briq exec`, `briq_set_sleep` → `briq
 * set-sleep`), with the tool's options as flags, each a call to `@briq/sdk`. What it adds is
 * only what a shell needs: signing in, files on disk, dotenv files, exit codes.
 */
const program = new Command('briq')
  .description('Run services for your agents: databases, queues, any OCI image')
  .version(VERSION)
  .option('--json', 'print the raw API response as JSON')
  .showHelpAfterError('(add --help for usage)')
  .allowExcessArguments(false)
  .exitOverride();

const json = () => program.opts().json === true;
const out = (v: unknown, human: () => string) =>
  console.log(json() ? JSON.stringify(v, null, 2) : human());
/** Messages for the person, kept off stdout so `--json` output stays parseable. */
const note = (line: string) => console.error(line);
const client = async () => (await openSession()).client;
const money = (cents: number) => formatMoney(cents);

/** Every command's action: errors become one line on stderr and an exit code (`errors.ts`). */
const run =
  <A extends unknown[]>(fn: (...args: A) => Promise<unknown> | unknown) =>
  async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      fail(e);
    }
  };

function fail(e: unknown): never {
  if (e instanceof BriqApiError) {
    console.error(pc.red(`${e.code}: ${e.message}`));
    if (e.details) console.error(pc.dim(JSON.stringify(e.details)));
    if (e.status >= 500 && e.requestId) console.error(pc.dim(`request id: ${e.requestId}`));
    if (e.status === 401) {
      console.error(pc.dim('run `briq logout`, then `briq login`, to sign in again'));
      process.exit(EXIT.auth);
    }
    process.exit(EXIT.error);
  }
  if (e instanceof CliError) {
    console.error(pc.red(e.message));
    process.exit(e.exitCode);
  }
  console.error(pc.red(String(e instanceof Error ? e.message : e)));
  process.exit(EXIT.error);
}

const fmtBriq = (b: {
  id: string;
  name: string;
  image: string;
  state: string;
  internalHost: string;
  costCentsSoFar: number;
  sleepsAt: string | null;
}) =>
  `${pc.bold(b.id)}  ${b.name.padEnd(12)} ${b.image.padEnd(28)} ${state(b.state)}  ${b.internalHost}  ${money(b.costCentsSoFar)}${b.sleepsAt ? `  sleeps ${b.sleepsAt.slice(11, 16)}Z unless used` : ''}`;
const state = (s: string) =>
  (s === 'running'
    ? pc.green(s)
    : s === 'error'
      ? pc.red(s)
      : s === 'sleeping'
        ? pc.dim(s)
        : pc.yellow(s)
  ).padEnd(10);

const mode = (v: string | undefined): ExposeMode | undefined => {
  if (v === undefined) return undefined;
  if (v !== 'private' && v !== 'public') throw usage(`expected private or public, got "${v}"`);
  return v;
};
const int = (v: string | undefined, what: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw usage(`${what} must be a whole number, got "${v}"`);
  return n;
};
const kv = (arr?: string[]) =>
  Object.fromEntries(
    (arr ?? []).map((s) => {
      const i = s.indexOf('=');
      if (i < 1) throw usage(`expected key=value, got "${s}"`);
      return [s.slice(0, i), s.slice(i + 1)];
    }),
  );
async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// ---- sign-in -------------------------------------------------------------------------------------

/** Who the CLI is: team, credential, budget, from `GET /v1/quota`. */
function describe(q: Quota, source: string, apiUrl: string) {
  const who =
    source === 'env'
      ? 'API key from BRIQ_API_KEY'
      : q.key?.kind === 'oauth'
        ? `${q.key.name} (signed in by link)`
        : q.key
          ? `API key "${q.key.name}"`
          : 'dashboard session';
  const p = q.policy;
  return [
    ['team', q.team ? `${q.team.name} (${q.team.slug}), plan ${q.plan}` : `plan ${q.plan}`],
    ['as', who],
    [
      'budget',
      `${money(p.dailySpendCapCents)} a day, ${p.maxConcurrentBriqs} briqs at once, sizes ${p.allowedSizes.join(', ')}`,
    ],
    ['api', `${apiUrl} (${environmentOf(apiUrl)})`],
  ]
    .map(([k, v]) => `${pc.dim((k ?? '').padEnd(7))} ${v}`)
    .join('\n');
}

async function save(apiUrl: string, credential: StoredCredential) {
  const token = credential.kind === 'key' ? credential.key : credential.accessToken;
  const q = await new Briq(token, { baseUrl: apiUrl, fetch: cliFetch }).quota().catch((e) => {
    if (e instanceof BriqApiError && e.status === 401)
      throw notSignedIn('the API refused this credential (unknown, revoked or expired)');
    throw e;
  });
  const file = saveConfig({ apiUrl, credential });
  out({ apiUrl, ...q }, () =>
    [`${pc.green('signed in')} ${pc.dim(`saved to ${file}`)}`, describe(q, 'file', apiUrl)].join(
      '\n',
    ),
  );
  if (process.env.BRIQ_API_KEY)
    note(pc.yellow('BRIQ_API_KEY is set: it wins over this sign-in until you unset it'));
}

program
  .command('login')
  .description('sign in: a link and a code to approve in a browser, or an API key with --key')
  .option('--key [key]', 'an API key (bq_live_…); without a value, read from piped stdin')
  .option('--api-url <url>', 'the API to sign in to (BRIQ_API_URL wins)')
  .action(
    run(async (o: { key?: string | true; apiUrl?: string }) => {
      const cfg = loadConfig();
      if (cfg.credential)
        throw usage(`already signed in to ${apiUrlOf(cfg)}: run \`briq logout\` first`);
      const apiUrl = o.apiUrl ? normalizeUrl(o.apiUrl) : apiUrlOf(cfg);
      if (o.key !== undefined) {
        if (o.key === true && process.stdin.isTTY)
          throw usage('pass the key: `briq login --key <key>`, or pipe it on stdin');
        const key = o.key === true ? (await readStdin()).toString('utf8').trim() : o.key.trim();
        if (!key) throw usage('no key on stdin');
        return save(apiUrl, { kind: 'key', key });
      }
      const as = await discover(apiUrl, cliFetch);
      const clientId = await register(as, VERSION, cliFetch);
      const code = await requestCode(as, clientId, cliFetch);
      note('Open this link to sign in, then pick the team and budget for the briq CLI:\n');
      note(`  ${pc.bold(code.link)}\n`);
      note(`Approve only if the page shows the code ${pc.bold(code.userCode)}.`);
      note(
        pc.dim(`Waiting for approval (the code works for ${Math.round(code.expiresIn / 60)} min)…`),
      );
      const tokens = await pollForTokens(as, clientId, code, cliFetch);
      return save(apiUrl, {
        kind: 'oauth',
        clientId,
        tokenEndpoint: as.tokenEndpoint,
        resource: as.resource,
        ...tokens,
      });
    }),
  );

/** The dashboard of the environment an API belongs to (`app.<domain>`), where agents are revoked. */
const dashboardOf = (apiUrl: string) =>
  ({
    production: 'https://app.briq.cloud',
    staging: 'https://app.stg.briq.cloud',
    local: 'http://app.localhost:3000',
  })[environmentOf(apiUrl)];

program
  .command('logout')
  .description('forget the saved sign-in (revoke it on the dashboard’s Agents page)')
  .action(
    run(() => {
      const cfg = loadConfig();
      const cred = cfg.credential;
      const agents = `${dashboardOf(apiUrlOf(cfg))}/agents`;
      if (!cred) note(`not signed in to ${apiUrlOf(cfg)}`);
      else {
        saveConfig({ ...(cfg.apiUrl ? { apiUrl: cfg.apiUrl } : {}) });
        // Revoking is a person's act on the dashboard (`requirePerson`); a credential cannot do it.
        out({ kind: cred.kind, agents }, () =>
          [
            pc.green('signed out on this machine'),
            cred.kind === 'oauth'
              ? `The sign-in stays connected until you revoke it: ${agents}`
              : `The key still works until you revoke it: ${agents}`,
          ].join('\n'),
        );
      }
      if (process.env.BRIQ_API_KEY) note(pc.yellow('BRIQ_API_KEY is still set in this shell'));
    }),
  );

program
  .command('whoami')
  .description('the team, credential and budget this CLI uses')
  .action(
    run(async () => {
      const { client: c, resolved, apiUrl } = await openSession();
      const q = await c.quota();
      out({ apiUrl, source: resolved.source, ...q }, () => describe(q, resolved.source, apiUrl));
    }),
  );

// ---- briqs: one command per MCP tool ------------------------------------------------------------

program
  .command('catalog')
  .description('recipes, or one recipe with its fields and outputs (briq_catalog)')
  .argument('[name]')
  .action(
    run(async (name: string | undefined) => {
      const c = await client();
      if (name) {
        const { recipe: r } = await c.recipe(name);
        return out(r, () =>
          [
            `${pc.bold(r.name)}: ${r.description}`,
            ...(r.parameters ?? []).map(
              (p) =>
                `  ${p.name.padEnd(14)} ${pc.dim(p.type)} ${p.description ?? ''}${p.defaultValue !== null ? pc.dim(` (default ${p.defaultValue})`) : ''}`,
            ),
            `outputs: ${r.outputs.join(', ')}`,
          ].join('\n'),
        );
      }
      const { recipes } = await c.recipes();
      out(recipes, () =>
        recipes
          .map(
            (r) =>
              `${pc.bold(r.name.padEnd(12))} ${r.description} ${pc.dim(`[${r.tags.join(', ')}]`)}`,
          )
          .join('\n'),
      );
    }),
  );

/** `--file <path>=<local file>`: text as it is, anything else as base64. */
const filesOf = (arr?: string[]): Record<string, FileContent> | undefined => {
  if (!arr?.length) return undefined;
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  return Object.fromEntries(
    Object.entries(kv(arr)).map(([path, local]) => {
      const bytes = readFileSync(local);
      try {
        return [path, utf8.decode(bytes)];
      } catch {
        return [path, { base64: bytes.toString('base64') }];
      }
    }),
  );
};
const portsOf = (arr?: string[]): number[] | undefined =>
  arr?.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw usage(`--port ${p}: a port number`);
    return n;
  });
const intOf = (flag: string, v?: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw usage(`${flag} ${v}: a whole number`);
  return n;
};

interface RunFlags {
  name?: string;
  stack?: string;
  size?: string;
  sleep?: string;
  expose?: string;
  image?: string;
  env?: string[];
  cmd?: string;
  port?: string[];
  file?: string[];
  volume?: string;
  volumeGb?: string;
  checkout?: string;
  ref?: string;
  path?: string;
  token?: string;
  step?: string[];
  wait: boolean;
}

/** `briq run`'s body: an image's spec, or a recipe with the fields beside it (`RecipeFields`). */
export function runInput(target: string, o: RunFlags): RunInput {
  const expose = mode(o.expose);
  const env = o.env?.length ? kv(o.env) : undefined;
  const ports = portsOf(o.port);
  const files = filesOf(o.file);
  const gb = intOf('--volume-gb', o.volumeGb);
  const common = {
    ...(o.stack ? { stack: o.stack } : {}),
    ...(expose ? { expose } : {}),
    wait: o.wait,
  };
  if (target.includes(':') || target.includes('/')) {
    for (const [flag, v] of [
      ['--image', o.image],
      ['--checkout', o.checkout],
      ['--step', o.step],
    ] as const)
      if (v !== undefined) throw usage(`${flag} is for a recipe; ${target} is an image`);
    if (gb !== undefined && !o.volume) throw usage('--volume-gb needs --volume <mount path>');
    return {
      spec: {
        name: o.name ?? target.split('/').pop()?.split(':')[0] ?? 'app',
        image: target,
        ...(env ? { env } : {}),
        ...(o.cmd ? { cmd: o.cmd } : {}),
        ...(ports ? { ports } : {}),
        ...(files ? { files } : {}),
        ...(o.volume ? { volume: { mount: o.volume, ...(gb ? { gb } : {}) } } : {}),
        ...(o.size ? { size: o.size as 'small' } : {}),
        ...(o.sleep ? { sleep: o.sleep } : {}),
      },
      ...common,
    };
  }
  if (o.volume)
    throw usage('--volume is for an image: a recipe mounts its own, size it with --volume-gb');
  if (!o.checkout)
    for (const [flag, v] of [
      ['--ref', o.ref],
      ['--path', o.path],
      ['--token', o.token],
    ] as const)
      if (v !== undefined) throw usage(`${flag} needs --checkout <repo>`);
  // A repo token travels as a secret's name; its value only from the environment, never a flag.
  const token = o.token
    ? { secret: o.token, ...(process.env[o.token] ? { value: process.env[o.token] } : {}) }
    : undefined;
  return {
    recipe: target,
    ...(o.name ? { name: o.name } : {}),
    ...(o.image ? { image: o.image } : {}),
    ...(env ? { env } : {}),
    ...(o.cmd ? { cmd: o.cmd } : {}),
    ...(o.size ? { size: o.size as 'small' } : {}),
    ...(gb ? { volume: { gb } } : {}),
    ...(files ? { files } : {}),
    ...(ports ? { ports } : {}),
    ...(o.checkout
      ? {
          checkout: {
            repo: o.checkout,
            ...(o.ref ? { ref: o.ref } : {}),
            ...(o.path ? { path: o.path } : {}),
            ...(token ? { token } : {}),
          },
        }
      : {}),
    ...(o.step?.length ? { steps: o.step.map((run) => ({ run })) } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...common,
  };
}

program
  .command('run')
  .description('run a recipe or an image (briq_run)')
  .argument('<recipeOrImage>', 'recipe name (postgres) or image (nginx:1.27)')
  .option('-n, --name <name>')
  .option('-s, --stack <stack>')
  .option('--size <size>')
  .option('--sleep <sleep>', 'sleep after this long without use: 30m, 3h, 7d, or never')
  .option('--expose <mode>', 'publish the front door: private or public')
  .option('--image <image>', "a recipe: another tag or a compatible image, instead of the recipe's")
  .option('-e, --env <K=V...>', "env vars, added to a recipe's or replacing one of its values")
  .option('--cmd <command>', 'the command, run with sh -c')
  .option('--port <n...>', "ports: an image's, or the port a language recipe's app listens on")
  .option('--file <path=local...>', 'a file written before the command starts, from a local file')
  .option('--volume <mount>', 'an image: a volume mounted there')
  .option('--volume-gb <n>', 'the volume size in GB')
  .option('--checkout <repo>', 'a language recipe: the code from a repo (github.com/owner/app)')
  .option('--ref <ref>', "the checkout's branch, tag or commit")
  .option('--path <dir>', "the checkout's directory inside the repo")
  .option('--token <NAME>', 'a private repo: the secret holding its token, read from $NAME')
  .option('--step <command...>', 'a language recipe: a command run before it starts, in order')
  .option('--no-wait', 'return before the briq is ready')
  .action(
    run(async (target: string, o: RunFlags) => {
      const input = runInput(target, o);
      const res = await (await client()).run(input);
      out(res, () =>
        [
          ...res.briqs.map(fmtBriq),
          ...Object.entries(res.outputs).map(([k, v]) => `${pc.cyan(k)}=${v}`),
          pc.dim(res.costLine),
        ].join('\n'),
      );
    }),
  );

registerUp(program, { client, out, fail, fmtBriq });

program
  .command('list')
  .description('briqs of the team (briq_list)')
  .option('-s, --stack <stack>')
  .option('-a, --all', 'destroyed briqs too')
  .action(
    run(async (o: { stack?: string; all?: boolean }) => {
      const r = await (await client()).list({
        ...(o.stack ? { stack: o.stack } : {}),
        ...(o.all ? { all: true } : {}),
      });
      out(r, () =>
        r.briqs.length ? `${r.briqs.map(fmtBriq).join('\n')}\n${pc.dim(r.costLine)}` : 'no briqs',
      );
    }),
  );

program
  .command('status')
  .description('one briq (briq_status)')
  .argument('<briq>')
  .action(
    run(async (id: string) => {
      const r = await (await client()).status(id);
      out(r, () => `${fmtBriq(r.briq)}\n${pc.dim(r.costLine)}`);
    }),
  );

const execLine = (e: Exec) =>
  [
    `${pc.bold(e.id)} ${e.state}${e.exitCode !== null ? ` (exit ${e.exitCode})` : ''}`,
    e.output?.stdout ?? '',
    e.output?.stderr ? pc.yellow(e.output.stderr) : '',
  ]
    .filter(Boolean)
    .join('\n');
/** An exec that ended badly ends the command badly: its exit code, or 1. */
const execExit = (e: Exec) =>
  e.state === 'exited' ? (e.exitCode ?? 0) : e.state === 'running' ? 0 : EXIT.error;

program
  .command('exec')
  .description('run a command in a briq; exits with its code (briq_exec)')
  .allowUnknownOption()
  .argument('<briq>')
  .argument('<cmd...>', 'the command; flags after the briq id go to it')
  .option('--async', 'start it and return its exec id at once (for anything over a minute)')
  .option('--timeout <ms>', 'how long it may run')
  .option('--stdin', "feed this command's stdin to it")
  .action(
    run(
      async (
        id: string,
        cmd: string[],
        o: { async?: boolean; timeout?: string; stdin?: boolean },
      ) => {
        const c = await client();
        const timeoutMs = int(o.timeout, '--timeout');
        const opts = {
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(o.stdin ? { stdin: (await readStdin()).toString('utf8') } : {}),
        };
        if (o.async) {
          const r = await c.execAsync(id, cmd, opts);
          return out(
            r,
            () => `${execLine(r.exec)}\n${pc.dim(`briq exec-result ${id} ${r.exec.id}`)}`,
          );
        }
        const r = await c.exec(id, cmd, opts);
        if (json()) console.log(JSON.stringify(r, null, 2));
        else {
          process.stdout.write(r.stdout);
          if (r.stderr) process.stderr.write(r.stderr);
          if (r.warning) note(pc.yellow(r.warning));
        }
        process.exit(r.exitCode);
      },
    ),
  );

program
  .command('exec-result')
  .description('where a command started with --async stands, and its output (briq_exec_result)')
  .argument('<briq>')
  .argument('<exec>')
  .option('--wait <ms>', 'wait this long for it to finish (45000 at most)')
  .action(
    run(async (id: string, execId: string, o: { wait?: string }) => {
      const waitMs = int(o.wait, '--wait');
      const r = await (await client()).execStatus(
        id,
        execId,
        waitMs !== undefined ? { waitMs } : {},
      );
      out(r, () => execLine(r.exec));
      process.exit(execExit(r.exec));
    }),
  );

program
  .command('exec-stop')
  .description('stop a command started with --async (briq_exec_stop)')
  .argument('<briq>')
  .argument('<exec>')
  .action(
    run(async (id: string, execId: string) => {
      const r = await (await client()).execStop(id, execId);
      out(r, () => execLine(r.exec));
    }),
  );

program
  .command('logs')
  .description("a briq's recent logs (briq_logs)")
  .argument('<briq>')
  .option('-n, --limit <n>')
  .option('--since <cursor>', 'the cursor a previous call printed')
  .action(
    run(async (id: string, o: { limit?: string; since?: string }) => {
      const limit = int(o.limit, '--limit');
      const r = await (await client()).logs(id, {
        ...(limit !== undefined ? { limit } : {}),
        ...(o.since ? { since: o.since } : {}),
      });
      out(r, () =>
        [
          ...r.lines.map((l) => `${pc.dim(l.ts)} ${l.line}`),
          ...(r.next ? [pc.dim(`more: --since ${r.next}`)] : []),
        ].join('\n'),
      );
    }),
  );

program
  .command('files-put')
  .description('upload a file into a briq, 1 MB at most (briq_files_put)')
  .argument('<briq>')
  .argument('<path>', 'absolute path inside the briq')
  .argument('[file]', 'the local file; piped stdin without it')
  .action(
    run(async (id: string, path: string, file: string | undefined) => {
      if (!file && process.stdin.isTTY) throw usage('pass a local file, or pipe the content');
      const bytes = file ? readFileSync(file) : await readStdin();
      const r = await (await client()).putFile(id, path, bytes.toString('base64'));
      out(
        r,
        () =>
          `${r.path}  ${r.bytes} bytes  sha256 ${r.sha256}${r.verified ? '' : pc.dim(' (not checked in the briq)')}`,
      );
    }),
  );

program
  .command('files-get')
  .description('download a file from a briq, 1 MB at most (briq_files_get)')
  .argument('<briq>')
  .argument('<path>', 'absolute path inside the briq')
  .option('-o, --out <file>', 'write it here instead of stdout')
  .action(
    run(async (id: string, path: string, o: { out?: string }) => {
      const r = await (await client()).getFile(id, path);
      const bytes = Buffer.from(r.contentBase64, 'base64');
      if (json()) return console.log(JSON.stringify(r, null, 2));
      if (o.out) {
        writeFileSync(o.out, bytes);
        return note(`${bytes.length} bytes written to ${o.out}`);
      }
      process.stdout.write(bytes);
    }),
  );

program
  .command('expose')
  .description('give a port a URL, or with --protocol a TCP endpoint over TLS (briq_expose)')
  .argument('<briq>')
  .argument('<port>')
  .option('--mode <mode>', 'private (only whoever has the URL) or public; a URL keeps its mode')
  .option(
    '--protocol <protocol>',
    'a TCP endpoint: postgres, mysql, redis, mongodb, amqp, bolt or grpc',
  )
  .option('--rotate', 'a new token for a private URL; the old one stops working')
  .action(
    run(
      async (
        id: string,
        port: string,
        o: { mode?: string; protocol?: string; rotate?: boolean },
      ) => {
        const r = await (await client()).expose(id, int(port, 'port') as number, mode(o.mode), {
          rotate: o.rotate === true,
          ...(o.protocol ? { protocol: o.protocol as EndpointProtocol } : {}),
        });
        out(r, () =>
          [r.connectionString ?? r.url, ...(r.warning ? [pc.yellow(r.warning)] : [])].join('\n'),
        );
      },
    ),
  );

program
  .command('fork')
  .description(
    'fork a briq, or with --stack every briq of a stack, from a copy of its disk (briq_fork)',
  )
  .argument('[briq]', 'the briq to fork alone')
  .option(
    '-s, --stack <stack>',
    'with a briq: the stack to put the fork in; alone: the stack to fork',
  )
  .option('--into <stack>', 'stack fork: the new stack (default <stack>-fork)')
  .option(
    '--branch <branch>',
    'stack fork: into the stack a git branch names (feat/login → feat-login)',
  )
  .option('--name <name>', 'single fork: its name (default <name>-fork)')
  .option('--sleep <sleep>', "the forks' sleep; the source's by default")
  .option(
    '--expose [mode]',
    'stack fork: reach it from outside briq (private by default, or public)',
  )
  .option('--env <file>', "write the fork's outputs into this dotenv file")
  .option('--no-wait', 'return before the forks are ready')
  .action(
    run(
      async (
        id: string | undefined,
        o: {
          stack?: string;
          into?: string;
          branch?: string;
          name?: string;
          sleep?: string;
          expose?: string | true;
          env?: string;
          wait: boolean;
        },
      ) => {
        if (!id && !o.stack) throw usage('pass a briq id, or --stack');
        if (id && (o.into || o.branch || o.expose))
          throw usage('--into, --branch and --expose are for a stack fork: pass --stack alone');
        if (o.into && o.branch) throw usage('pass --into or --branch, not both');
        // A branch's fork is the stack its name makes, as the API and MCP name it.
        const into = o.into ?? (o.branch ? slugify(o.branch) : undefined);
        if (!id && o.name) throw usage('--name is for a single fork');
        if (o.env && !o.wait) throw usage('--env needs the forks ready: leave out --no-wait');
        const expose = o.expose === true ? 'private' : mode(o.expose);
        const c = await client();
        const common = {
          wait: o.wait,
          waitTimeoutMs: 300_000,
          ...(o.sleep ? { sleep: o.sleep } : {}),
        };
        const res = id
          ? await c.fork(id, {
              ...common,
              ...(o.name ? { name: o.name } : {}),
              ...(o.stack ? { stack: o.stack } : {}),
            })
          : await c.forkStack(o.stack as string, {
              ...common,
              ...(into ? { into } : {}),
              ...(expose ? { expose } : {}),
            });
        if (o.env)
          writeEnv(
            o.env,
            res.outputs,
            `stack ${res.stack}${o.branch ? `, branch ${o.branch}` : ''}`,
          );
        out(res, () =>
          [
            `stack ${res.stack}${o.branch ? ` (${o.branch})` : ''}`,
            ...res.briqs.map(fmtBriq),
            ...(o.env
              ? [pc.dim(`${Object.keys(res.outputs).length} values written to ${o.env}`)]
              : Object.entries(res.outputs).map(([k, v]) => `${pc.cyan(k)}=${v}`)),
            ...(res.skipped.length
              ? [pc.yellow(`skipped (in error): ${res.skipped.join(', ')}`)]
              : []),
            ...(res.warning ? [pc.yellow(res.warning)] : []),
            pc.dim(res.costLine),
          ].join('\n'),
        );
        if (res.briqs.some((b) => b.state === 'error')) process.exit(EXIT.error);
      },
    ),
  );

for (const a of ['stop', 'start'] as const) {
  program
    .command(a)
    .description(`${a} a briq (briq_${a})`)
    .argument('<briq>')
    .action(
      run(async (id: string) => {
        const r = await (await client())[a](id);
        out(r, () => fmtBriq(r.briq));
      }),
    );
}

program
  .command('destroy')
  .description('destroy a briq, or with --stack every briq of a stack (briq_destroy)')
  .argument('[briq]')
  .option('-s, --stack <stack>', 'a stack, by name or id')
  .option('--branch <branch>', 'the stack a git branch names, as fork --branch made it')
  .action(
    run(async (id: string | undefined, o: { stack?: string; branch?: string }) => {
      const stack = o.stack ?? (o.branch ? slugify(o.branch) : undefined);
      if (!id === !stack || (o.stack && o.branch))
        throw usage('pass a briq id, --stack or --branch');
      const c = await client();
      if (stack) {
        const r = await c.destroyStack(stack);
        return out(r, () => [`stack ${r.stack.name}`].concat(r.briqs.map(fmtBriq)).join('\n'));
      }
      const r = await c.destroy(id as string);
      out(r, () => fmtBriq(r.briq));
    }),
  );

program
  .command('set-sleep')
  .description('when a briq goes to sleep: 30m, 3h, 7d, or never (briq_set_sleep)')
  .argument('<briq>')
  .argument('<sleep>')
  .option('--stack', 'the same for every briq of its stack')
  .action(
    run(async (id: string, sleep: string, o: { stack?: boolean }) => {
      const r = await (await client()).setSleep(id, sleep, o.stack ? { stack: true } : {});
      out(r, () => r.briqs.map(fmtBriq).join('\n'));
    }),
  );

program
  .command('quota')
  .description('what this credential may still spend and run today (briq_quota)')
  .action(
    run(async () => {
      const q = await (await client()).quota();
      out(
        q,
        () =>
          `plan ${q.plan} · spent today ${money(q.spentTodayCents)} / ${money(q.policy.dailySpendCapCents)} · credits ${money(q.creditBalanceCents)} · ${q.liveBriqs} live, ${q.remainingConcurrency} more allowed`,
      );
    }),
  );

program
  .command('feedback')
  .description('write to the briq team: a bug, an idea, a question (briq_feedback)')
  .argument('<topic>', 'bug, idea or question')
  .argument('<message...>')
  .action(
    run(async (topic: string, message: string[]) => {
      if (!['bug', 'idea', 'question'].includes(topic)) throw usage('topic: bug, idea or question');
      const r = await (await client()).feedback({
        topic: topic as SupportTopic,
        message: message.join(' '),
      });
      out(r, () => `sent (ref ${r.requestId})`);
    }),
  );

program
  .command('mcp')
  .description('how to add briq to an MCP client')
  .action(
    run(() => {
      const site = {
        production: 'https://briq.cloud',
        staging: 'https://stg.briq.cloud',
        local: 'http://localhost:3000',
      }[environmentOf(apiUrlOf(loadConfig()))];
      out({ docs: `${site}/docs/setup/clients` }, () => `${site}/docs/setup/clients`);
    }),
  );

/** Runs the CLI on `argv` (`process.argv`). */
export async function main(argv: string[]) {
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError) process.exit(e.exitCode === 0 ? EXIT.ok : EXIT.usage);
    fail(e);
  }
}
