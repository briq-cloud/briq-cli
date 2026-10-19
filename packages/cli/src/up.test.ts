import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Briq as BriqClient, StackUpInput, StackUpResult } from '@briq/sdk';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { findStackFile, registerUp, secretValues, upReport } from './up.js';

const FILE =
  'stack: app\nservices:\n  db: { recipe: postgres }\n  web:\n    image: nginx\n    env: { STRIPE_KEY: { secret: STRIPE_KEY } }\n';

const result: StackUpResult = {
  stack: 'app',
  briqs: [
    { id: 'bq_1', name: 'db', state: 'running' },
    { id: 'bq_2', name: 'web', state: 'running' },
  ] as StackUpResult['briqs'],
  created: ['web'],
  existing: ['db'],
  warnings: ['web: the endpoint opens once it runs'],
  outputs: { DATABASE_URL: 'postgres://postgres:pw@m_1:5432/app', 'web:URL': 'https://web-x' },
  costLine: 'cost so far €0.00',
};

describe('briq up', () => {
  it('finds briq.yaml here or in a parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'briq-up-'));
    const deep = join(root, 'apps', 'web');
    mkdirSync(deep, { recursive: true });
    expect(findStackFile(deep)).toBe(null);
    writeFileSync(join(root, 'briq.yaml'), FILE);
    expect(findStackFile(deep)).toBe(join(root, 'briq.yaml'));
  });

  it('sends the secrets asked for, from the flag or the environment, nothing else', () => {
    const env = { STRIPE_KEY: 'sk_env', HOME: '/root', EMPTY: '' };
    expect(secretValues([], env)).toEqual({});
    expect(secretValues(['STRIPE_KEY'], env)).toEqual({ STRIPE_KEY: 'sk_env' });
    expect(secretValues(['STRIPE_KEY=sk=flag', 'GH=x'], env)).toEqual({
      STRIPE_KEY: 'sk=flag',
      GH: 'x',
    });
    expect(() => secretValues(['EMPTY'], env)).toThrow(/not set/);
    expect(() => secretValues(['=x'], env)).toThrow(/NAME=value/);
  });

  it('reports what it created, the warnings and the outputs', () => {
    const text = upReport(result, (b) => `${b.id} ${b.name}`);
    expect(text).toContain('1 created, 1 already there');
    expect(text).toContain('bq_2 web');
    expect(text).toContain('the endpoint opens once it runs');
    expect(text).toContain('DATABASE_URL');
    expect(upReport(result, (b) => b.id, '.env.local')).toContain('2 values written to .env.local');
  });

  it('reads the file, waits, and writes the outputs into an env file readable by its owner only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'briq-up-'));
    const file = join(dir, 'briq.yaml');
    const env = join(dir, '.env.local');
    writeFileSync(file, FILE);
    writeFileSync(env, 'PORT=3000\nDATABASE_URL=postgres://localhost/dev\n', { mode: 0o600 });
    const sent: StackUpInput[] = [];
    const printed: string[] = [];
    const program = new Command('briq').exitOverride();
    registerUp(program, {
      client: async () =>
        ({
          up: async (input: StackUpInput) => {
            sent.push(input);
            return result;
          },
        }) as unknown as BriqClient,
      out: (_v, human) => printed.push(human()),
      fail: (e) => {
        throw e;
      },
      fmtBriq: (b) => b.id,
    });
    process.env.STRIPE_KEY = 'sk_test';
    process.env.OTHER = 'not sent';
    await program.parseAsync(
      ['up', '-f', file, '--env', env, '--stack', 'feat-x', '--secret', 'STRIPE_KEY'],
      { from: 'user' },
    );
    expect(sent).toEqual([
      {
        file: FILE,
        stack: 'feat-x',
        secrets: { STRIPE_KEY: 'sk_test' },
        wait: true,
        waitTimeoutMs: 300_000,
      },
    ]);
    const written = readFileSync(env, 'utf8');
    expect(written).toContain('PORT=3000');
    expect(written).toContain('DATABASE_URL=postgres://postgres:pw@m_1:5432/app');
    expect(written).toContain('WEB_URL=https://web-x');
    expect(written).not.toContain('postgres://localhost/dev');
    expect(printed[0]).toContain('values written to');

    // a new env file is created readable by its owner only
    const fresh = join(dir, '.env.new');
    await program.parseAsync(['up', '-f', file, '--env', fresh], { from: 'user' });
    expect(statSync(fresh).mode & 0o777).toBe(0o600);

    // --expose asks for outputs this machine can use, and needs the wait
    const fresh2 = () => {
      const p = new Command('briq').exitOverride();
      registerUp(p, {
        client: async () =>
          ({
            up: async (input: StackUpInput) => {
              sent.push(input);
              return result;
            },
          }) as unknown as BriqClient,
        out: () => undefined,
        fail: (e) => {
          throw e;
        },
        fmtBriq: (b) => b.id,
      });
      return p;
    };
    await fresh2().parseAsync(['up', '-f', file, '--expose'], { from: 'user' });
    expect(sent.at(-1)).toEqual({ file: FILE, expose: true, wait: true, waitTimeoutMs: 300_000 });
    await expect(
      fresh2().parseAsync(['up', '-f', file, '--expose', '--no-wait'], { from: 'user' }),
    ).rejects.toThrow(/--expose needs the briqs ready/);
    Reflect.deleteProperty(process.env, 'STRIPE_KEY');
    Reflect.deleteProperty(process.env, 'OTHER');
  });
});
