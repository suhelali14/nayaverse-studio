/**
 * The house theme's defaults, as plain JSON for the browser.
 *
 * Why generated rather than written: the browser editor needs the default
 * theme, and importing the zod schema to get it drags 146KB of validator
 * into a bundle that never validates anything. Writing the numbers out by
 * hand instead would let them drift from the schema, which is the one
 * failure this whole codebase is arranged to prevent.
 *
 * So the schema stays the single definition and this emits from it. Run by
 * `prebuild`; the output is gitignored.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Theme } from '../src/domain/workspace.js';

/**
 * One consumer: the React app under `apps/studio-web`, which is the editor.
 *
 * There used to be a second, the plain-HTML prototype under
 * `apps/studio/web`. It was the first place the engine ran in a browser and
 * React replaced it; it stayed reachable on its own dev server long enough
 * to be mistaken for the product, so it is no longer generated for or
 * started by anything.
 */
const targets = [
  join(import.meta.dirname, '..', '..', 'studio-web', 'src', 'editor', 'theme-defaults.json'),
];
const json = JSON.stringify(Theme.parse({}), null, 2) + String.fromCharCode(10);
for (const out of targets) {
  writeFileSync(out, json, 'utf8');
  console.log('theme defaults -> ' + out);
}
console.log(JSON.stringify(Theme.parse({})));
