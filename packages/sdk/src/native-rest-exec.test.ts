import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { IN_DIR, inDir } from './native-rest-exec.js';

const run = promisify(execFile);
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'briq-indir-'));
});
afterAll(() => rm(root, { recursive: true, force: true }));
const command = (cwd: string, cmd: string[]) =>
  inDir({ cmd, cwd, env: {}, timeoutMs: 5000, onChunk: () => {} });
// What the provider runs: the argv as it is, no shell of its own.
const exec = async (cwd: string, cmd: string[], env: NodeJS.ProcessEnv = {}) => {
  const [file, ...args] = command(cwd, cmd);
  try {
    const out = await run(file!, args, { env });
    return { code: 0, ...out };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
};

it('runs the command in the directory with the environment it would have on the stream', async () => {
  const dir = join(root, 'work');
  await mkdir(dir);
  const out = await exec(dir, ['/usr/bin/env'], { PATH: '/usr/bin:/bin', A: '1' });
  expect(out.code).toBe(0);
  const vars = Object.fromEntries(
    out.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  expect(vars.A).toBe('1');
  expect(vars).not.toHaveProperty('PWD');
  expect(vars).not.toHaveProperty('OLDPWD');
  expect((await exec(dir, ['pwd'], { PATH: '/usr/bin:/bin' })).stdout.trim()).toMatch(/work$/);
});
it('finds /bin/sh whatever PATH the caller sets, and the command by that PATH', async () => {
  const out = await exec('/', ['sh', '-c', 'echo ok'], { PATH: '/nonexistent' });
  // sh itself is not on that PATH: the command is not found (127), the wrapper still ran
  expect(out.code).toBe(127);
  const found = await exec('/', ['/bin/echo', 'ok'], { PATH: '/nonexistent' });
  expect(found.code).toBe(0);
});
it('never reads the directory or the command as shell: hostile names run nothing', async () => {
  // A directory name cannot hold a slash, so the commands inside it are relative: they would
  // create `pwned` in the directory the shell is in, if anything ran them.
  const name = `a b'"$(touch pwned)\`touch pwned\`;touch pwned;\\n`;
  const hostile = join(root, name);
  await mkdir(hostile);
  const out = await exec(hostile, ['/bin/echo', '$(touch pwned)', ';touch', 'pwned', '`id`', '-n']);
  expect(out.code).toBe(0);
  expect(out.stdout).toBe('$(touch pwned) ;touch pwned `id` -n\n');
  for (const where of [hostile, root, process.cwd(), '/'])
    await expect(stat(join(where, 'pwned'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('a directory that is not there ends with 126 before the command starts, text printed as is', async () => {
  const marker = join(root, 'ran');
  const missing = join(root, 'no\\nsuch dir');
  const out = await exec(missing, ['/usr/bin/touch', marker]);
  expect(out.code).toBe(126);
  // the shell may say its own words first; ours is the last line, the path printed byte for byte
  expect(out.stderr.endsWith(`briq: cannot enter ${missing}\n`)).toBe(true);
  await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('a missing command is 127 and one that cannot be run is 126, as on the stream', async () => {
  expect((await exec('/', ['briq-no-such-tool'], { PATH: '/usr/bin:/bin' })).code).toBe(127);
  expect((await exec('/', [root])).code).toBe(126);
});
it('is one script, with the directory as a parameter', () => {
  expect(IN_DIR).not.toContain(root);
  expect(command('/x', ['a'])).toEqual(['/bin/sh', '-c', IN_DIR, 'briq-cwd', '/x', 'a']);
});
