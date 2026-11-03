# studio

Social content automation as a platform. A user describes their business
once; the platform decides what to post, builds it, holds it for approval,
and publishes it.

Nothing about any particular business is in the code. That is the whole
design, and the first version of this got it wrong — it had one company's
feature list compiled into the prompt, which made it an internal script
wearing a platform's clothes.

## The shape

```
studio init <slug> "Name"     start a workspace
studio doctor [slug]          what is configured, what is missing
studio packs                  rule packs a channel can opt into
studio draft <slug>           write the next post for each channel
studio review <slug>          read the queue, approve or reject
studio publish <slug>         send everything approved
```

The split is deliberate. `draft` never publishes, `publish` never writes,
and `review` is a person. A bad idea costs a draft rather than a post.

## A workspace is the product

`workspaces/<slug>/workspace.json` is what a user fills in. See
[`workspaces/example-bakery`](workspaces/example-bakery/workspace.json) for a
filled-in one — a bakery, chosen because it has nothing to do with the
business that prompted this, which is the point.

The fields that decide output quality, in order:

| Field | Why it matters more than it looks |
|---|---|
| `context.whatWorks` | Specifics are what make a post credible. A model cannot invent a true feature list. |
| `context.doesNotExist` | Stops the automation promising what you lack. Every business has this list and almost nobody writes it down, which is why so much marketing copy is quietly false. |
| `context.mustNotClaim` | Compiled into a check that runs over the finished draft, not just a request in a prompt. |
| `channels[].audience` | A named person, not a segment. "A receptionist at a two-doctor clinic" produces different copy from "healthcare professionals". |
| `context.assets` | The *descriptions* matter more than the files. `shot1.png` is unusable; "the queue, reordered by triage, on a phone" is a shot a model reaches for deliberately. |

## Why a model proposes and code refuses

Deciding what is worth saying to a particular person today is judgement, and
a model is good at that and bad at remembering a constraint for the
four-hundredth time. Code is the reverse.

So the model writes and `lib/guard.ts` checks. A prompt that says "never
claim a cure" works nearly always, and nearly always is the wrong standard
for something that publishes daily with nobody reading it: complying on 99
drafts in 100 still ships several bad posts a year, and the one that matters
is the one nobody saw.

Rules come from three places — `always` (claims nobody can substantiate, not
optional), the packs a channel opts into, and the user's own two lists.

**None of it is legal advice, and a pack passing does not make a post
lawful.** The approval gate is what makes a post safe, because a person took
responsibility for it. `autoPublish` exists, defaults to false, and the
reason to leave it false is that a meme account and a medical device company
carry very different consequences for one bad post.

## Rendering

ffmpeg, via `ffmpeg-static` — no system install. Shots are fitted inside a
1080×1920 frame rather than cropped to fill, because cropping a UI cuts off
the thing being pointed at.

Generated video is deliberately absent. On the machine this was built for it
costs 10–20 minutes a clip and needs more system RAM than the machine has
free; a reel of real product captures renders in seconds and is *true*,
which for selling software is not the cheap option but the persuasive one.

**Non-Latin captions need a font.** ffmpeg's default has no Devanagari
glyphs, so a Marathi caption renders as nothing at all — silently, with a
zero exit code. Put a `.ttf` at `workspaces/<slug>/fonts/<lang>.ttf`. The
renderer warns when a caption needs one and none is there.

## Publishing

Instagram Reels via Meta's Content Publishing API. Two things surprise
people: the video goes to `rupload.facebook.com`, not `graph.facebook.com`
(which is also what makes a local-first tool possible — a reel can be
uploaded from disk, while images must be fetched from a public URL); and if
the Facebook Page has not completed **Page Publishing Authorization**,
publishing is refused with an error that does not mention PPA.

Requires an Instagram **professional** account and
`instagram_business_basic` + `instagram_business_content_publish`.

**This code has never run against the real API.** It typechecks and follows
the documentation. Treat the first real run as the test, on one account,
with something you would not mind deleting.

Other platforms are in the schema and not implemented; `publish` says so
rather than failing.

## Credentials

In `.env`, keyed by workspace and then channel — never in `workspace.json`,
which is meant to be read, corrected and shared. See `.env.example`.
