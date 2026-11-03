/**
 * Cleaning what comes in and what a model sends back.
 *
 * Validation (zod, per route) says whether a request has the right shape.
 * This says whether its text is safe to keep: Unicode in one normal form,
 * no control characters, no keys that would rewrite an object's prototype.
 * It runs on every JSON body and query string before any route sees them
 * (`plugins/security.ts`), so a route written next year is covered without
 * remembering to call anything.
 */

/** Keys that, merged into an object, change its prototype instead of a field. */
const POISON = new Set(['__proto__', 'constructor', 'prototype']);

/** Control characters other than tab, newline and carriage return, and the bidi overrides used to disguise text. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g;

export const MAX_DEPTH = 12;
export const MAX_ARRAY = 500;

export class UnsafeInput extends Error {}

/**
 * One string, made safe to store: NFC (so "é" typed two ways is one
 * string, and Devanagari compares equal however the keyboard composed it),
 * without control or direction-override characters.
 */
export function cleanText(value: string): string {
  return value.normalize('NFC').replace(CONTROL, '');
}

/**
 * Clean a parsed JSON value in place-free fashion: returns a new value.
 * Throws `UnsafeInput` on prototype-pollution keys, nesting deeper than
 * `MAX_DEPTH`, or arrays longer than `MAX_ARRAY` -- shapes no form in this
 * product produces, so their only source is someone probing.
 */
export function cleanDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new UnsafeInput('That request is nested too deeply.');
  if (typeof value === 'string') return cleanText(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) throw new UnsafeInput('That request has too many items.');
    return value.map((v) => cleanDeep(v, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      if (POISON.has(key)) throw new UnsafeInput('That request contains a field name that is not allowed.');
      out[cleanText(key)] = cleanDeep((value as Record<string, unknown>)[key], depth + 1);
    }
    // A plain object again, so routes and zod see what they expect.
    return { ...out };
  }
  return value;
}

/**
 * Text a creator wrote, made safe to place inside a prompt's fence.
 *
 * Prompts put user text between tags (`<script>…</script>`) and tell the
 * model that what is inside is material, not instructions. A closing tag
 * typed into the text would end the fence early and let the rest read as
 * instructions; so tag-shaped sequences are neutralised, by breaking the
 * angle bracket rather than deleting text the creator meant.
 */
export function fence(value: string, max = 8000): string {
  return cleanText(value)
    .slice(0, max)
    .replace(/<(\/?)([a-z_][\w-]*)([^>]*)>/gi, '‹$1$2$3›');
}

/** A model's string, before it reaches a page: no markup, no control characters. */
export function cleanModelText(value: string): string {
  return cleanText(value)
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

/** Every string in a model's structured output, cleaned. */
export function cleanModelOutput<T>(value: T): T {
  if (typeof value === 'string') return cleanModelText(value) as T;
  if (Array.isArray(value)) return value.map((v) => cleanModelOutput(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cleanModelOutput(v);
    return out as T;
  }
  return value;
}
