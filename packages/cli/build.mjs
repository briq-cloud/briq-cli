// Bundles the CLI into dist/index.js: the workspace packages it uses (@briq-cloud/sdk, @briq/public) go
// inside, from their source; npm packages stay dependencies (package.json).
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: `node${pkg.engines.node.replace(/^>=/, '').split('.')[0]}`,
  external: Object.keys(pkg.dependencies),
  // The SDK from its source, not its dist: the sandbox layer it also exports (and `ws` behind it)
  // is dropped when the CLI does not use it, which a bundle of a bundle does not manage.
  alias: { '@briq-cloud/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)) },
  sourcemap: false,
  logLevel: 'warning',
});
chmodSync('dist/index.js', 0o755);
