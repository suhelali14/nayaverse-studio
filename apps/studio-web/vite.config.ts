import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * The editor's engine lives in `apps/studio/src`, written for Node, so its
 * relative imports carry a `.js` extension as NodeNext requires. Vite looks
 * for that file on disk and finds nothing.
 *
 * Rewriting the specifier keeps ONE copy of the geometry solver shared
 * between the server renderer and this browser app. Duplicating those files
 * would defeat the entire point of having one solver.
 */
const nodeNextJsToTs = (): Plugin => ({
  name: 'studio:nodenext-js-to-ts',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const asTs = resolve(dirname(importer), source.replace(/\.js$/, '.ts'));
    return existsSync(asTs) ? asTs : null;
  },
});

export default defineConfig({
  plugins: [react(), nodeNextJsToTs()],
  // STUDIO_API_URL points a second dev server at a second API, for QA.
  server: { port: 5179, proxy: { '/api': process.env.STUDIO_API_URL ?? 'http://localhost:4300' } },
  build: { target: 'es2022', sourcemap: true },
});
