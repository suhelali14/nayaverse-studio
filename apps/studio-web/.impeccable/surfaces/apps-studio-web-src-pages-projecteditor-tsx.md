---
version: 1
slug: "apps-studio-web-src-pages-projecteditor-tsx"
primary_target: "apps/studio-web/src/pages/ProjectEditor.tsx"
related_targets: ["apps/studio-web/src/index.css","apps/studio-web/src/components","apps/studio-web/src/pages"]
---

# Studio editor, app and website

## Scope and mode

The Studio SaaS app in `apps/studio-web`: the project editor (primary), the
signed-in app (Reels, Insights, Ideas, Connections, Plan & billing) and the
sign-in flow, all **Operate**; the landing and pricing pages, **Persuade**.

## Audience and job

All creator types equally: solo faceless-channel creators, Indian small
businesses making their own promo reels, and agencies batch-producing for
clients. Laptops, day and night. The job: topic or script in, a cut,
captioned 9:16 reel out, dubbed if needed, every step still editable on a
frame-exact timeline; then connected accounts tell them what worked and
what to make next.

## Constraints

- Ruled out by the user: dark navy with a blue glow; cream paper with serif.
- Nothing hardcoded: prices, plans, regions, currencies and languages come
  from `GET /api/catalogue`; colours and type only through tokens.
- No invented claims: no customers, testimonials, ratings, counts or
  industry benchmarks. Insights compare a creator only with themselves.
- Anything not switched on is marked Coming soon, never ticked.
- Captions must render Indian scripts (Devanagari and others) correctly.

## Decided by the user

- 2026-11-02, captions inside the reel: **"Keep the current look"** --
  outlined white text over footage, a band only over screenshots.
- 2026-11-03, **the On Air world is retired.** The user said the design
  "looks like AI created" and asked for it to be rebuilt like professional
  app UI. Evidence gathered: the copy narrated itself (honesty disclaimers,
  "no AI was used", "Built by one engineer..."), a broadcast theme was
  painted over every screen, and the editor lacked a professional editor's
  parts. Replaced by the direction below.

## Direction contract

THESIS: A professional tool, not a themed one. The editor looks and behaves
like the category's best editors -- tool rail, library panel, viewer,
contextual inspector, multi-track timeline -- so a creator who has used
CapCut, Descript or Resolve trusts it on sight. The brand lives in one red
and in precise details; the copy states, it never narrates.

OWN-WORLD: Two rooms, one token set. The website and sign-in are light
(white ground, ink type) because they are read in daylight by someone
deciding. The signed-in app is dark neutral graphite (`data-theme="dark"`
on /app routes) because its job is judging pictures, and a bright frame
changes how footage reads. Red is the only saturated colour: the primary
action and the playhead. The selected clip is outlined in ink, as the
category's editors outline it, so the selection never competes with the
playhead crossing it. Clip kinds on the timeline get muted
hues (blue video, teal photo, violet card, amber captions). Archivo at
normal width for everything, tabular figures for timecode and money,
Mukta for Devanagari. Corners: controls 6px, cards 8px, product frames
12px. Shadows only on things that float.

FORM: the category's own form, by the user's direction ("see professional
app UI then do ours"), so no concept seed was rolled. Editor anatomy from
CapCut desktop (rail and library panel), Descript (properties that follow
the selection) and DaVinci Resolve's Cut page (viewer above a full-width
timeline); the signed-in app as a standard sidebar shell; the website as a
product-led SaaS page whose hero is the product.

FIRST VIEWPORT (editor): 48px top bar (back, mark, reel name and length,
Export draft). Left: 64px tool rail (Script, Media, Scenes, Captions, Dub,
each with a done/working dot) and a 312px panel for the chosen tool, every
panel kept mounted. Centre: the viewer on near-black with transport under
it, and a "Start with a script" prompt while the timeline is empty.
Undo and redo in the top bar (Ctrl+Z, Ctrl+Shift+Z). Right: 288px inspector -- the selected clip's caption, timing, source
and actions, or the reel's details when nothing is selected. Bottom: the
timeline with track headers (Video, Captions), ruler, clips with
thumbnails, cue chips, red playhead.

WEBSITE (revised 2026-11-03, user asked for a "$3-4k" site with Motion and
three.js): split hero -- the sentence and actions left, a three.js scene of
the sample reel's five Studio-rendered frames over that cut's timeline right
(HTML fallback, pause control, still under reduced motion); the editor
capture settling flat; a sticky stage that zooms the real editor capture to
the part each workflow step is about (wizard, scenes, timeline, look,
export); captions in English, Hindi and Tamil; dubbing and insights marked
Coming soon; plans; questions; a dark close over a film strip of the reel.
The header carries a ruler with a playhead at scroll position.

FINISH: unreviewed and undocumented is unfinished; this build ends with a
finish review, DESIGN.md regenerated from the shipped code, and every
shipping raster carrying its provenance (`src/assets/product/*.jpg` carry
a JPEG comment naming the capture script and the drawn sample b-roll).

## Unresolved

- Captures use drawn sample b-roll; swap in a creator's real footage, with
  permission, when there is some.
- Platform API shapes (Instagram Graph v23.0, YouTube Data v3, TikTok v2)
  were implemented without a live account; verify on first real connect.
