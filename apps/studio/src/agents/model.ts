import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';

/**
 * The one place this codebase talks to a model.
 *
 * ── Why it is an interface and not a function ────────────────────────
 *
 * Five roles each making their own SDK call is five places to get retries,
 * JSON handling and token limits subtly different, and no way to exercise
 * the pipeline without spending money. Behind one interface, a stub drives
 * the whole graph in a test: the orchestration, the candidate selection and
 * every guard run for real, and only the writing is faked.
 *
 * That matters more than it sounds. The bugs in a pipeline like this are
 * almost never in the prose -- they are in which role got handed what.
 */

export interface Completion {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Model {
  readonly name: string;
  complete(system: string, user: string, maxTokens: number): Promise<Completion>;
}

/** Tokens and rupees spent on one run, accumulated across every role. */
export class Ledger {
  #in = 0;
  #out = 0;
  #calls = 0;

  record(c: Completion): void {
    this.#in += c.inputTokens;
    this.#out += c.outputTokens;
    this.#calls += 1;
  }

  get calls(): number {
    return this.#calls;
  }

  /**
   * What this run cost.
   *
   * Prices are per million tokens and are a FIGURE IN A FILE, not a quote:
   * model prices change, and a number baked into a repo goes stale quietly.
   * `studio doctor` prints the rates it is using so a wrong one is visible
   * rather than silently wrong in a monthly projection.
   */
  usd(inPerM: number, outPerM: number): number {
    return (this.#in / 1e6) * inPerM + (this.#out / 1e6) * outPerM;
  }

  summary(inPerM: number, outPerM: number): string {
    return (
      `${this.#calls} call(s), ${this.#in} in / ${this.#out} out tokens, ` +
      `$${this.usd(inPerM, outPerM).toFixed(5)}`
    );
  }
}

export class ClaudeModel implements Model {
  readonly name: string;
  readonly #client: Anthropic;

  constructor(model = env.STUDIO_MODEL) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set, so there is nothing to think with. See .env.example.',
      );
    }
    this.name = model;
    this.#client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  async complete(system: string, user: string, maxTokens: number): Promise<Completion> {
    const res = await this.#client.messages.create({
      model: this.name,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
    };
  }
}

/**
 * A model that returns canned answers, for exercising the pipeline.
 *
 * Keyed by role name rather than by call order: a stub keyed on order
 * silently passes when two roles are swapped, which is exactly the bug
 * worth catching.
 */
export class StubModel implements Model {
  readonly name = 'stub';
  readonly seen: string[] = [];

  constructor(private readonly answers: Record<string, string>) {}

  async complete(system: string, _user: string, _maxTokens: number): Promise<Completion> {
    const role = /^ROLE:\s*(\S+)/m.exec(system)?.[1] ?? 'unknown';
    this.seen.push(role);
    const text = this.answers[role];
    if (text === undefined) {
      throw new Error(
        `StubModel has no answer for role "${role}". Roles asked so far: ${this.seen.join(', ')}`,
      );
    }
    return { text, inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * JSON out of a completion.
 *
 * Bare JSON is asked for and usually given; a fenced block is the common
 * deviation and is far cheaper to accept than to re-prompt. Anything else
 * throws with the model's own words attached, because "invalid JSON" with
 * the text hidden is unfixable.
 */
export function asJson<T>(text: string, what: string): T {
  const stripped = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(stripped) as T;
  } catch {
    throw new Error(`${what}: the model did not return JSON. It said:\n${text.slice(0, 400)}`);
  }
}
