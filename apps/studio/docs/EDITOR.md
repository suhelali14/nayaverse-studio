# The editor: architecture, and what "better than Adobe" can mean

## The prior decision does not apply here

`docs/EDITOR-RENDERER.md` argued against a C++/WebGL core for the **website**
editor. Its central argument was that a website's output *is* DOM, so a GPU
renderer forces you to maintain two renderers that will disagree.

**A video editor's output is pixels.** That argument inverts completely.
For video, a canvas/GPU compositing architecture is not a risk — it is what
every browser-based editor does, because there is no DOM at the other end to
stay faithful to. The four costs that killed it for websites (text shaping
in twelve scripts, a hand-built accessibility tree, two renderers
disagreeing, opportunity cost) either vanish or shrink here: the text in a
reel is a handful of burnt-in captions, and the export is a file.

So: different question, different answer. Do not read the old document as
precedent for this one.

## "Better than Adobe" — the honest version

Premiere Pro is roughly three decades of work. A solo founder does not beat
it at being Premiere, and a product that tries is a worse Premiere.

But Premiere is **general-purpose**, and general-purpose tools are reliably
bad at specific workflows. A creator making a vertical talking-head reel
from a phone recording does the same eight things every single time:
reframe to 9:16, cut the dead air, drop in captions matched to the script,
drop in two b-roll shots, check it on mute, export, post.

In Premiere that is a project file, a sequence preset, a transcript panel,
an essential-graphics template, a media encoder queue, and an upload. **In a
tool that only does this, it is one screen.**

That is the winnable version: not more features than Adobe, *ten times
faster at the one job*. It is also the version where the competitors are
[OpusClip](https://www.castmagic.io/blog/opus-clip-pricing) and
[Submagic](https://www.viraldrop.ai/compare/submagic-pricing) at $15–39, not
Adobe at $23 — and those are beatable.

## Do you need C++?

**Not for v1, and probably not ever for the editing surface.**

The reason people reach for C++/Wasm (Figma's path) is that the browser
gives you no primitive fast enough. For video that stopped being true:
[WebCodecs](https://www.freecodecamp.org/news/the-webcodecs-handbook-native-video-processing-in-the-browser/)
exposes the browser's own **hardware** encoders and decoders at frame level
through `VideoDecoder` / `VideoEncoder`. That is the expensive part, already
native, already GPU-backed. One source claims it runs
[3–10× faster than ffmpeg.wasm](https://loopdesk.ai/blog/webcodecs-api-explained-browser-video-editing)
for H.264 — unverified, but the direction is not in doubt, because one is
hardware and the other is software in a sandbox.

What you would write in C++ — a compositor and a codec — is the part the
browser now hands you. Writing it anyway means shipping a multi-megabyte
Wasm bundle to do what `VideoEncoder` does natively.

**Constraints worth knowing before committing:**

- WebCodecs has **no muxing or demuxing**. You need a separate container
  library (`mp4box.js` or equivalent). This surprises people.
- A decoder needs a **full codec string**; hardware decoders support narrow
  configuration bands and fail outside them.
- Safari shipped `VideoEncoder`/`VideoDecoder` in **16.4**, but
  `AudioEncoder`/`AudioDecoder` only in **Safari 26**. For an audio-carrying
  editor that is the real support floor.
- The spec is still a **Working Draft**.

## The architecture

```
        ┌──────────────────────────────────────────────┐
        │  TIMELINE DOCUMENT   src/lib/timeline.ts     │  ← built, 52 tests
        │  split, trim, ripple, reorder, compact       │
        └───────────────────────┬──────────────────────┘
                                │
        ┌───────────────────────▼──────────────────────┐
        │  GEOMETRY SOLVER     src/lib/compose.ts      │  ← built
        │  "what is on screen at t", as integers.      │
        │  NOTHING else computes a rectangle.          │
        └───────────┬──────────────────────┬───────────┘
                    │                      │
      ┌─────────────▼────────────┐   ┌─────▼──────────────────┐
      │  PREVIEW (browser)       │   │  EXPORT (server)       │
      │  src/web/paint.ts        │   │  src/lib/filtergraph.ts│
      │  seek.ts + framecache.ts │   │  → ffmpeg filters       │
      │  + decoder.ts            │   │  deterministic, exact   │
      └──────────────────────────┘   └────────────────────────┘
                    │                            │
                    └────────── proven equal ────┘
                       two-renderers.test.mts (58)
                       render-parity.test.mts  (44, real pixels)
```

**One document, two renderers, and that is deliberate.** The old website
analysis warned that two renderers will disagree — and here they will, in
the ways that do not matter (preview may drop frames, skip a filter, be a
shade off) and must not in the ways that do (durations, cut points, caption
text). The timeline document is the contract between them, which is why it
has 52 tests and the renderers have none for geometry.

The preview is allowed to be approximate because **the export is the
deliverable**. Figma cannot make that trade; a video tool can.

## Why export OTIO rather than lock creators in

You said you want an ecosystem creators will not leave. The export is how
you get one.

[OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO)
is the Academy Software Foundation's interchange format — it carries cuts,
order and media references, not media. Resolve, Kdenlive and Olive read it;
Premiere does via adapters.

A creator evaluating a new editor asks what happens to their work if they
stop. "Nothing comes out" ends the evaluation on the spot. A tool nobody can
leave is a tool nobody tries. The thing that keeps people is being better at
the daily job — and the export cost about forty lines.

It also buys the professional segment: an editor who will not abandon
Resolve can still use this for the first pass if the edit travels.

## What is built

| | status |
|---|---|
| Timeline document + operations | **built**, 52 tests, mutation-verified |
| Geometry solver, one per frame | **built**, parity proven at pixel level |
| ffmpeg backend, generated from it | **built**, 44 pixel assertions |
| Canvas backend, generated from it | **built**, 58 draw-call assertions |
| GOP seek planner | **built**, 30× measured vs naive |
| Frame cache, zero leaks | **built**, 360 created / 360 accounted |
| Hardware decode loop | **built**, 60 tests against a fake codec |
| OTIO export | **built**, frame-accurate |
| Clip cutting with audio preserved | **built**, verified −24 dB vs −91 dB |
| Browser editor UI | **built**, bundles to 132 kB gzipped |
| Browser export | **built**, silent by design (see TECHNOLOGY.md) |
| Transcript alignment | not built |
| Visual confirmation of the UI | **not done** — no browser ran here |

See `docs/TECHNOLOGY.md` for the measurements and the two silent ffmpeg
bugs this arrangement found.

The document model exists before the UI on purpose. When the UI lands, it is
correct exactly when it produces the documents these tests describe — the
same discipline that gave `canvas-doc.ts` its 103 geometry tests.

## Sources

- [The WebCodecs Handbook](https://www.freecodecamp.org/news/the-webcodecs-handbook-native-video-processing-in-the-browser/) · [WebCodecs explained](https://www.digitalsamba.com/blog/webcodecs-api-explained) · [Browser video editors](https://loopdesk.ai/blog/webcodecs-api-explained-browser-video-editing)
- [Client-side rendering in 2026](https://www.captio.work/blog/client-side-video-rendering-2026)
- [OpenTimelineIO architecture](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/master/docs/tutorials/architecture.md) · [Tools using OTIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/wiki/Tools-and-Projects-Using-OpenTimelineIO)
- [Kdenlive](https://github.com/kde/kdenlive) and MLT — the C++ engine behind Kdenlive, Shotcut and Flowblade, if a native core is ever genuinely needed
- [Figma's Wasm/GPU architecture](https://madebyevan.com/figma/webassembly-cut-figmas-load-time-by-3x) — the case that does need C++, and why this is not it
