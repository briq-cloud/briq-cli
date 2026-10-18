import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * The CLI is published: its bundle on npm, its sources in a public repo. Both are made only of
 * these three packages, and none of them names our infrastructure or our internal code.
 */
const packages = fileURLToPath(new URL('../../', import.meta.url));
const PUBLISHED = ['cli/src', 'sdk/src', 'public/src'];

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
];

const sources = PUBLISHED.flatMap((dir) =>
  readdirSync(join(packages, dir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f)),
);

describe('what the CLI publishes', () => {
  it('bundles only the CLI, the SDK and @briq/public', async () => {
    const pkg = JSON.parse(readFileSync(join(packages, 'cli/package.json'), 'utf8'));
    const out = await build({
      absWorkingDir: packages,
      entryPoints: ['cli/src/index.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      outfile: 'out.js',
      external: Object.keys(pkg.dependencies),
      logLevel: 'silent',
    });
    const inputs = Object.keys(out.metafile.inputs);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.filter((f) => !/^(?:cli\/src|sdk\/dist|public\/dist)\//.test(f))).toEqual([]);
  });

  it.each(sources)('%s names nothing internal', (file) => {
    const text = readFileSync(join(packages, file), 'utf8');
    expect(INTERNAL.filter((re) => re.test(text)).map(String)).toEqual([]);
  });
});
