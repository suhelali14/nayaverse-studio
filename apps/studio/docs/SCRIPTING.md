# How a post gets written

The pipeline, what the research said, and what was deliberately not built.

## The shape

```
strategist  → what is worth saying, and which hook archetypes suit it
hooksmith   → one opening per archetype
[code]        dead openings refused here, before anyone chooses
critic      → picks one (skipped when only one survived)
scriptwriter→ the body, built around that opening
art-director→ what each beat shows (the only role that sees the assets)
[code]        rule guard, render, review, publish
```

Five model calls. Four when the shortlist collapses to one.

## What earns a role

A role exists where the job is genuinely different judgement, not where a
diagram would look fuller. Three tests:

1. **Does it need different instructions?** Hook writing and body writing
   have different rules. Asking for both in one call gets the average.
2. **Is its output worth rejecting on its own?** A premise can be thrown
   away for the price of one short call, before a script is paid for.
3. **Does splitting it buy a choice?** The hooksmith returns several and a
   critic picks one. A single call returning a single hook has nothing to
   pick between.

## What is deliberately not a role

Editing, assembly, the rule guard and publishing are code.

- A model that renders is a slower, dearer, less reliable `ffmpeg`.
- A model that checks rules is the thing the rules exist to compensate for.
  The whole point of `lib/guard.ts` is that code remembers a constraint for
  the four-hundredth time and a model does not.
- The orchestrator is a function with a fixed order and two decision
  points. A model would get that order right almost every time, which is
  the problem: "almost every time", running daily and unattended, is a bug
  you discover in a published post.

The split this codebase already had is unchanged. **Models decide, code
refuses and executes.** More roles writing does not mean fewer checks.

## What the research actually supported

Read across short-form scripting guides and the open-source pipelines
below. Two things were worth taking:

**Generate candidates, then select.** ViMax generates two keyframes and has
a vision model choose between them. The same pattern applied where it is
cheap: the hooksmith writes one opening per archetype and a critic picks.
A hook is ~15 tokens, so a shortlist costs almost nothing and is the single
highest-leverage place to spend an extra call.

**A human review gate in the middle.** The faceless-channel pipelines that
run unattended still put a review step before publishing. `studio review`
was already this; nothing here changed it.

**What was NOT taken: the numbers.** Every guide attaches retention
percentages to hook types — "35–45% higher 3-second retention" and so on.
Those are vendor figures, self-reported, measured against unstated
baselines, by companies selling hook tools. So `packs/hooks.ts` records the
archetypes and records none of the claims. Which archetype works for a
given account is a question that account's own retention data answers.

The one thing every source agreed on, and which is therefore *enforced*
rather than requested: **openings that cost retention.** Greetings, channel
intros, "in this video". A model trained on a decade of video intros writes
one anyway, so `deadOpening()` refuses them in code before the critic ever
sees a shortlist.

## Nothing about a business is in the code

Everything a post is derived from lives in `workspace.json`:

| What | Where | Default |
|---|---|---|
| The business, what works, what must not be claimed | `context` | required |
| Who is being spoken to | `channels[].audience` | required |
| Post shape — beats, seconds, caption words, shortlist size | `channels[].shape` | 5–7 beats, 2–4s, 7 words, 4 hooks |
| How the reels look — ground, ink, type sizes, wrap | `theme` | the house style |
| Which rule packs apply | `channels[].rulePacks` | always-on only |

Frame size (1080×1920), codec and the audio track are **not** configurable.
Those are Instagram's requirements, not a preference.

Model prices are configuration too (`STUDIO_PRICE_IN_PER_M`,
`STUDIO_PRICE_OUT_PER_M`) and affect only the cost line `draft` prints — a
price compiled into a repo goes stale silently, and a stale price produces
a confident monthly projection that is wrong.

## Testing it without spending anything

`Model` is an interface. `StubModel` returns canned answers keyed **by role
name**, not by call order — a stub keyed on order passes silently when two
roles are swapped, which is exactly the bug worth catching.

```
npx tsx test/pipeline.test.mts
```

16 checks. Role ordering, the dead-opening refusal, the critic skip, the
invented-asset fallback, and the rule guard all run for real; only the
prose is faked. Verified by mutation: neutering `deadOpening` fails 3.

## Sources

Scripting and hook structure:
- [Short-Form Video Scripting in 2026: The 3-Second Hook & Retention Blueprint](https://www.grow-it.se/en/resources/short-form-video-scripting-retention-hooks)
- [Viral Hook Formulas for Short-Form Video: The 2026 Framework](https://ugccopilot.ai/blog/viral-hooks-that-convert/)
- [Hook-Retain-Reward: the Short-Form Video Structure](https://www.selfstorming.com/tools/libraries/frameworks/hook-retain-reward)
- [Short-Form Video Hooks: First 3-Second Patterns](https://www.capcut.com/create/short-form-video-hooks-first-3-second-patterns)
- [How to Script Short-Form Videos That Keep Viewers Watching](https://gpt.social/blog/how-to-script-short-form-videos-2026)

Pipeline architectures:
- [HKUDS/ViMax](https://github.com/HKUDS/ViMax) — MIT, Python 3.12, 12.8k
  stars. Director/Screenwriter/Producer roles, remote models (Gemini, Veo,
  Seedance). Source of the candidate-and-select pattern.
- [awesome-faceless](https://github.com/sasharun/awesome-faceless) and
  [ai-filmmaking](https://github.com/topics/ai-filmmaking) — state-machine
  pipelines with a review gate before upload.

Generated-video pricing, if a shot ever needs to be generated rather than
shot (all third-party figures, worth re-checking at the provider):
- [AI Video API Pricing in 2026](https://apiframe.ai/blog/ai-video-api-pricing-2026)
- [Runway API Pricing](https://docs.dev.runwayml.com/guides/pricing/)
- [Best AI Video Generation APIs in 2026](https://higgsfield.ai/blog/best-ai-video-generation-apis)
