import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * The shared modules under `src/` are written for Node, so their relative
 * imports carry a `.js` extension, as NodeNext requires. Vite resolves
 * against the real filesystem and finds no such file.
 *
 * Rewriting the specifier here is the smallest fix that keeps ONE copy of
 * the geometry solver. The alternatives were worse: duplicating the shared
 * files for the browser defeats the entire purpose of having one solver,
 * and dropping the extensions breaks the Node build and every test.
 */
const resolveNodeNextExtensions = (): Plugin => ({
  name: 'studio:nodenext-js-to-ts',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
    const asTs = resolve(dirname(importer), source.replace(/\.js$/, '.ts'));
    return existsSync(asTs) ? asTs : null;
  },
});

export default defineConfig({
  root: import.meta.dirname,
  plugins: [resolveNodeNextExtensions()],
  build: { outDir: 'dist', target: 'es2022', sourcemap: true },
  server: { port: 5178, open: false },
});
