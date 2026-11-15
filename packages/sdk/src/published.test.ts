import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSdk } from '../build.mjs';

/**
 * The SDK is published: its bundle on npm, its sources in a public repo. Nothing in them names our
 * infrastructure or our internal code, and the packed tarball works with the dependencies it
 * declares and nothing else. It has one entry: the client and, beside it, the sandbox layer that
 * adapters for other SDKs build on.
 */
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const packages = join(root, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const INTERNAL = [
  /\bfly(?:\.io)?\b/i,
  /firecracker/i,
  /stripe/i,
  /railway/i,
  /cloudflare/i,
  /hetzner|\bovh\b|scaleway/i,
  /\bADR\b/,
  /\bapps\//,
  /bqt-/,
  /@briq\/(?:core|api|db|providers|recipes|mcp)\b/,
  /\bledger\b/i,
  /briqyard/i,
];

// The sources and the tests of both packages: the mirror publishes the tests too. This file lists
// the internal names, so it is the one file left out.
const sources = ['sdk/src', 'public/src'].flatMap((dir) =>
  readdirSync(join(packages, dir))
    .filter((f) => f.endsWith('.ts') && f !== 'published.test.ts')
    .map((f) => join(dir, f)),
);

/** The `ws` the SDK declares, from the workspace's install: the real package, at the pinned version. */
const wsDir = dirname(require.resolve('ws/package.json', { paths: [root] }));

const scratch = mkdtempSync(join(tmpdir(), 'briq-sdk-pack-'));
const tarball = () => join(scratch, readdirSync(scratch).find((f) => f.endsWith('.tgz')) as string);
let metafile: Awaited<ReturnType<typeof buildSdk>>;
let installed: string;

beforeAll(async () => {
  // Build and pack in a scratch copy: other packages' tests read this package's dist/ meanwhile.
  const stage = join(scratch, 'stage');
  metafile = await buildSdk(join(stage, 'dist'));
  for (const f of ['package.json', 'LICENSE', 'README.md']) cpSync(join(root, f), join(stage, f));
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch], {
    cwd: stage,
    stdio: 'pipe',
  });
  // A clean project: the tarball unpacked as npm would, and nothing else.
  installed = join(scratch, 'project');
  const dir = join(installed, 'node_modules/@briq-cloud/sdk');
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', tarball(), '-C', dir, '--strip-components=1']);
  writeFileSync(join(installed, 'package.json'), '{"type":"module"}');
  // The one dependency, as npm would install it next to the package. `ws` has no dependency of its
  // own (its two native add-ons are optional), so a copy of the package is what an install makes.
  cpSync(wsDir, join(installed, 'node_modules/ws'), { recursive: true, dereference: true });
}, 60_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('what the SDK publishes', () => {
  it('bundles only the SDK: @briq/public is types, and the imports are Node and ws', () => {
    const inputs = Object.keys(metafile.inputs).map((f) => f.replace(/^.*packages\//, ''));
    expect(inputs.filter((f) => !f.startsWith('src/'))).toEqual([]);
    expect(inputs).toContain('src/native-sandbox.ts');
    const imports = (entry: string) =>
      (
        metafile.outputs[Object.keys(metafile.outputs).find((o) => o.endsWith(entry)) as string]
          ?.imports ?? []
      )
        .map((i) => i.path)
        .filter((p) => !p.startsWith('node:'))
        .filter((p, i, all) => all.indexOf(p) === i)
        .sort();
    expect(imports('index.js')).toEqual(['ws']);
    // `ws` is the only dependency, as a range; the one installed here satisfies it.
    expect(pkg.dependencies).toEqual({ ws: '^8.21.0' });
    expect(JSON.parse(readFileSync(join(wsDir, 'package.json'), 'utf8')).version).toMatch(
      /^8\.(2[1-9]|[3-9]\d)\./,
    );
  });

  it.each(sources)('%s names nothing internal', (file) => {
    const text = readFileSync(join(packages, file), 'utf8');
    expect(INTERNAL.filter((re) => re.test(text)).map(String)).toEqual([]);
  });

  it('ships only dist/, the license, the manifest and the readme, with nothing internal in them', () => {
    const files = execFileSync('tar', ['-tzf', tarball()], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/^package\//, ''))
      .sort();
    expect(files).toEqual([
      'LICENSE',
      'README.md',
      'dist/index.d.ts',
      'dist/index.js',
      'package.json',
    ]);
    for (const f of files.filter((f) => f.startsWith('dist/'))) {
      const text = readFileSync(join(installed, 'node_modules/@briq-cloud/sdk', f), 'utf8');
      expect(INTERNAL.filter((re) => re.test(text)).map(String), f).toEqual([]);
      expect(text, f).not.toMatch(/@briq\/|zod/);
    }
    const manifest = JSON.parse(
      readFileSync(join(installed, 'node_modules/@briq-cloud/sdk/package.json'), 'utf8'),
    );
    expect(manifest.dependencies).toEqual({ ws: '^8.21.0' });
    // One entry, under `default` so that `require` finds it as well as `import`.
    expect(manifest.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    });
    // `pnpm pack` writes real versions over devDependencies; nothing a user installs is a workspace link.
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'])
      expect(JSON.stringify(manifest[field] ?? {})).not.toMatch(/workspace:/);
  });

  it('imports and runs in a clean project, with only ws installed', () => {
    const script = `
      import { Briq, BriqApiError } from '@briq-cloud/sdk';
      const calls = [];
      const briq = new Briq('bk_test', {
        baseUrl: 'http://api.test',
        fetch: async (url, init) => {
          calls.push([init?.method ?? 'GET', String(url), init?.headers?.authorization]);
          return Response.json({ error: { code: 'not_found', message: 'no such briq' } }, { status: 404 });
        },
      });
      const err = await briq.status('bq_1').catch((e) => e);
      if (!(err instanceof BriqApiError) || err.status !== 404 || err.code !== 'not_found')
        throw new Error('unexpected: ' + err);
      console.log(JSON.stringify(calls));`;
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      cwd: installed,
      encoding: 'utf8',
    });
    expect(JSON.parse(out)).toEqual([['GET', 'http://api.test/v1/briqs/bq_1', 'Bearer bk_test']]);
  });

  it('runs the sandbox layer from the one entry: a 404 is not_found, with import and require', () => {
    // The sandbox layer decides on `instanceof BriqApiError`: with a second copy of the class, a 404
    // would come out as `unavailable` and not `not_found`.
    const check = `
      const sandbox = nativeSandbox({
        apiKey: 'bk_test',
        baseUrl: 'http://api.test',
        fetch: async () => Response.json({ error: { code: 'not_found', message: 'no such briq' } }, { status: 404 }),
      });
      const err = await sandbox.connect('bq_1').catch((e) => e);
      if (!(err instanceof BriqOperationError) || err.code !== 'not_found') throw new Error('unexpected: ' + err);
      if (!(fail('auth', 'x') instanceof BriqOperationError)) throw new Error('fail');
      console.log(JSON.stringify([err.code, typeof Briq, typeof BriqApiError, typeof runArgv, typeof files]));`;
    const esm = `import { Briq, BriqApiError, BriqOperationError, fail, files, nativeSandbox, runArgv } from '@briq-cloud/sdk';${check}`;
    const cjs = `(async () => {
      const { Briq, BriqApiError, BriqOperationError, fail, files, nativeSandbox, runArgv } = require('@briq-cloud/sdk');${check}
    })();`;
    const expected = ['not_found', 'function', 'function', 'function', 'function'];
    const run = (args: string[]) =>
      JSON.parse(execFileSync('node', args, { cwd: installed, encoding: 'utf8' }));
    expect(run(['--input-type=module', '-e', esm])).toEqual(expected);
    expect(run(['--input-type=commonjs', '-e', cjs])).toEqual(expected);
  });

  describe('typechecks for a consumer, with no @types package installed', () => {
    const tsc = join(
      dirname(require.resolve('typescript/package.json', { paths: [packages] })),
      'bin/tsc',
    );
    const check = (name: string, options: Record<string, unknown>) => {
      writeFileSync(
        join(installed, `tsconfig.${name}.json`),
        JSON.stringify({
          compilerOptions: {
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2022',
            strict: true,
            skipLibCheck: false,
            lib: ['ES2023', 'DOM'],
            types: [],
            ...options,
          },
          include: ['use.ts', 'sandbox-use.ts', 'adapter.ts'],
        }),
      );
      try {
        execFileSync('node', [tsc, '-p', `tsconfig.${name}.json`], {
          cwd: installed,
          stdio: 'pipe',
        });
      } catch (err) {
        throw new Error(String((err as { stdout?: Buffer }).stdout));
      }
    };
    beforeAll(() => {
      writeFileSync(
        join(installed, 'use.ts'),
        `import { Briq, BriqApiError, type BriqRecord, type RunInput, type RunResult } from '@briq-cloud/sdk';
const briq = new Briq('bk_test');
const input: RunInput = { recipe: 'postgres' };
const run: Promise<RunResult> = briq.run(input);
async function state(): Promise<BriqRecord['state']> {
  const result = await run;
  return result.briqs[0]?.state ?? 'error';
}
// A wrong state is an error, so the record's type is real and not any.
// @ts-expect-error
const wrong: BriqRecord['state'] = 'no-such-state';
export { BriqApiError, state, wrong };
`,
      );
      writeFileSync(
        join(installed, 'sandbox-use.ts'),
        `import {
  Briq,
  BriqOperationError,
  type Command,
  type CommandResult,
  fail,
  files,
  nativeSandbox,
  runArgv,
} from '@briq-cloud/sdk';
const sandbox = nativeSandbox({ apiKey: 'bk_test', eagerChecks: false });
const command: Command = { cmd: ['true'], cwd: '/', env: {}, timeoutMs: 1000, onChunk() {} };
const result: Promise<CommandResult> = runArgv('http://api.test', 'bk_test', 'bq_1', command);
const created = sandbox.create({ labels: {} });
const code: BriqOperationError['code'] = fail('auth', 'no').code;
const read: Promise<Uint8Array> = files(new Briq('bk_test'), async () => true, async () => ({ exitCode: 0, timedOut: false })).read('bq_1', '/a');
// The client's own ExecResult is not the sandbox layer's CommandResult.
// @ts-expect-error
const clash: import('@briq-cloud/sdk').ExecResult = { exitCode: 0, timedOut: false };
// Only the adapters' surface is exported.
// @ts-expect-error
import { safe } from '@briq-cloud/sdk';
export { clash, code, created, read, result, safe };
`,
      );
      // What an adapter does: re-exports functions whose return types come from the SDK. With a type
      // the declarations do not export, emitting the adapter's own declarations fails (TS4058).
      writeFileSync(
        join(installed, 'adapter.ts'),
        `import { type Briq, type Command, fail, files, nativeSandbox, runArgv } from '@briq-cloud/sdk';
type Sandbox = ReturnType<typeof nativeSandbox>;
export const sandboxFor = (apiKey: string) => nativeSandbox({ apiKey });
export const filesOf = files;
export const fork = (c: Briq) => c.fork;
export const run = runArgv;
// Each of these has a type of the SDK in its signature that the adapter's declarations must name.
export const stat = (f: ReturnType<typeof files>) => f.stat('bq_1', '/');
export const prepare = (input: Parameters<Sandbox['create']>[0]) => input;
export const execution = (input: Parameters<Sandbox['exec']>[1]) => input;
export const options = (input: Parameters<typeof nativeSandbox>[0]) => input;
export const chunk = (c: Parameters<Command['onChunk']>[0]) => c;
export const failure = (code: Parameters<typeof fail>[0]) => fail(code, 'no');
export const outcome = (c: Command) => runArgv('http://api.test', 'k', 'bq_1', c);
`,
      );
    });
    it('with types only', () => check('types', { noEmit: true }));
    it('emitting declarations, so an adapter can re-export what it returns', () =>
      check('declarations', { declaration: true, emitDeclarationOnly: true, outDir: 'out' }));
  });
});
