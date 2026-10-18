import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envName, envValue, mergeEnv, writeEnv } from './envfile.js';

describe('env file', () => {
  it('replaces the keys it writes, keeps every other line, appends the new ones', () => {
    const before = [
      '# mine',
      'PORT=3000',
      'export DATABASE_URL=postgres://localhost/dev',
      '',
      'SECRET="keep me"',
    ].join('\n');
    const after = mergeEnv(
      `${before}\n`,
      {
        DATABASE_URL: 'postgres://postgres:pw@m_1.vm.x.internal:5432/app',
        REDIS_URL: 'redis://h:6379',
      },
      'stack feat-x, branch feat/x',
    );
    expect(after).toBe(
      [
        '# mine',
        'PORT=3000',
        'export DATABASE_URL=postgres://postgres:pw@m_1.vm.x.internal:5432/app',
        '',
        'SECRET="keep me"',
        '',
        '# briq: stack feat-x, branch feat/x',
        'REDIS_URL=redis://h:6379',
        '',
      ].join('\n'),
    );
    // written again (another fork of the branch): in place, nothing duplicated
    const again = mergeEnv(after, { REDIS_URL: 'redis://other:6379' }, 'stack feat-x-2');
    expect(again.match(/REDIS_URL=/g)).toHaveLength(1);
    expect(again).toContain('REDIS_URL=redis://other:6379');
    expect(again).toContain('# briq: stack feat-x-2');
    expect(again.match(/# briq:/g)).toHaveLength(1);
  });

  it('quotes what needs quoting and names clashing keys', () => {
    expect(envValue('postgres://u:p@h:5432/db?sslmode=require')).toBe(
      'postgres://u:p@h:5432/db?sslmode=require',
    );
    // Single quotes: nothing inside is expanded by dotenv-expand, Next.js or Compose.
    expect(envValue('pa$$word')).toBe("'pa$$word'");
    expect(envValue('a b"c\\d$HOME')).toBe(`'a b"c\\d$HOME'`);
    // A value single quotes cannot hold: double quotes, `$` escaped too.
    expect(envValue("it's $x\nnext")).toBe('"it\'s \\$x\\nnext"');
    expect(envName('db:DATABASE_URL')).toBe('DB_DATABASE_URL');
    expect(mergeEnv(null, { A: '1' }, 'stack s')).toBe('# briq: stack s\nA=1\n');
  });

  it('creates the file readable by its owner only, and keeps a file’s mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'briq-env-'));
    const f = join(dir, '.env.local');
    writeEnv(f, { DATABASE_URL: 'postgres://x' }, 'stack s');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(f, 'utf8')).toContain('DATABASE_URL=postgres://x');
    const g = join(dir, '.env');
    writeFileSync(g, 'A=1\n', { mode: 0o644 });
    writeEnv(g, { B: '2' }, 'stack s');
    expect(statSync(g).mode & 0o777).toBe(0o644);
    expect(readFileSync(g, 'utf8')).toBe('A=1\n\n# briq: stack s\nB=2\n');
  });
});
