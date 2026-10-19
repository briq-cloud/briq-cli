import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { STACK_FILE_NAME } from '@briq/public';
import type { Briq as BriqClient, BriqRecord, StackUpResult } from '@briq/sdk';
import type { Command } from 'commander';
import pc from 'picocolors';
import { writeEnv } from './envfile.js';
import { usage } from './errors.js';

/**
 * `briq up`: bring a stack up from its stack file, `briq.yaml` (found in the current directory or
 * one of its parents, or named with `-f`). The file goes to the API as it is, which reads and
 * checks it; the CLI adds only the secret values asked for with `--secret`.
 */

/** The stack file in `dir` or the closest parent that has one, or null. */
export function findStackFile(dir: string): string | null {
  let at = resolve(dir);
  for (;;) {
    const file = join(at, STACK_FILE_NAME);
    if (existsSync(file)) return file;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * The secret values to send, from `--secret NAME=value`, or `--secret NAME` for the value of that
 * environment variable. Never the rest of the environment.
 */
export function secretValues(
  flags: string[] = [],
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of flags) {
    const i = f.indexOf('=');
    if (i === 0)
      throw usage(`--secret ${f}: write it NAME=value, or NAME to read it from the environment`);
    if (i > 0) {
      out[f.slice(0, i)] = f.slice(i + 1);
      continue;
    }
    const v = env[f];
    if (!v) throw usage(`--secret ${f}: ${f} is not set in the environment`);
    out[f] = v;
  }
  return out;
}

/** What `briq up` prints: the stack, each briq, the warnings, then the outputs or where they went. */
export function upReport(
  r: StackUpResult,
  fmtBriq: (b: BriqRecord) => string,
  envFile?: string,
): string {
  return [
    `stack ${pc.bold(r.stack)}: ${r.created.length} created, ${r.existing.length} already there`,
    ...r.briqs.map(fmtBriq),
    ...(r.warnings ?? []).map((w) => pc.yellow(w)),
    ...(envFile
      ? [pc.dim(`${Object.keys(r.outputs).length} values written to ${envFile}`)]
      : Object.entries(r.outputs).map(([k, v]) => `${pc.cyan(k)}=${v}`)),
    pc.dim(r.costLine),
  ].join('\n');
}

export interface UpDeps {
  client: () => Promise<BriqClient>;
  out: (v: unknown, human: () => string) => void;
  fail: (e: unknown) => void;
  fmtBriq: (b: BriqRecord) => string;
}

export function registerUp(program: Command, deps: UpDeps) {
  program
    .command('up')
    .description(`bring a stack up from ${STACK_FILE_NAME}: create the services it does not have`)
    .option('-f, --file <path>', `the stack file; default: ${STACK_FILE_NAME} here or in a parent`)
    .option('-s, --stack <name>', "bring it up as this stack instead of the file's")
    .option(
      '--secret <NAME=value...>',
      'the value of a { secret: NAME } of the file; NAME alone reads it from the environment',
    )
    .option('--env <file>', 'write the outputs into this dotenv file')
    .option('--expose', 'outputs this machine can use: databases get TLS endpoints')
    .option('--no-wait', 'return before the new briqs are ready')
    .action(
      async (o: {
        file?: string;
        stack?: string;
        secret?: string[];
        env?: string;
        expose?: boolean;
        wait: boolean;
      }) => {
        try {
          const path = o.file ?? findStackFile(process.cwd());
          if (!path)
            return deps.fail(
              usage(`no ${STACK_FILE_NAME} here or in a parent directory: write one, or pass -f`),
            );
          const text = readFileSync(path, 'utf8');
          const secrets = secretValues(o.secret);
          // Outputs name the new briqs' hosts once they have machines: an env file needs the wait.
          if ((o.env || o.expose) && !o.wait)
            return deps.fail(
              usage(`${o.env ? '--env' : '--expose'} needs the briqs ready: leave out --no-wait`),
            );
          const wait = o.wait;
          const r = await (await deps.client()).up({
            file: text,
            ...(o.stack ? { stack: o.stack } : {}),
            ...(Object.keys(secrets).length ? { secrets } : {}),
            ...(o.expose ? { expose: true } : {}),
            wait,
            waitTimeoutMs: 300_000,
          });
          if (o.env) writeEnv(o.env, r.outputs, `stack ${r.stack}`);
          deps.out(r, () => upReport(r, deps.fmtBriq, o.env));
          if (wait && r.briqs.some((b) => b.state === 'error')) process.exit(1);
        } catch (e) {
          deps.fail(e);
        }
      },
    );
}
