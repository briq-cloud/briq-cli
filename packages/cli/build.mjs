// Bundles the CLI into dist/index.js: the workspace packages it uses (@briq/sdk, @briq/public) go
// inside, since they are not published; npm packages stay dependencies (package.json).
import { chmodSync, readFileSync, rmSync } from 'node:fs';
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
  sourcemap: false,
  logLevel: 'warning',
});
chmodSync('dist/index.js', 0o755);
