// The API as one JavaScript file for production.
//
// In development the API runs from TypeScript through tsx. A server should
// not compile on start, nor carry a TypeScript toolchain, so this bundles
// src/index.ts -- and the engine it imports from ../studio -- into
// dist/index.mjs. Packages stay external and are installed in the image as
// production dependencies, so native pieces like ffmpeg-static keep their
// own files.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [root + 'src/index.ts'],
  outfile: root + 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  // JSON the engine imports (theme defaults) is inlined.
  loader: { '.json': 'json' },
  logLevel: 'info',
});
