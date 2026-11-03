# The technology

What is actually novel here, what it is built on, and what is measured
rather than claimed.

Run `npm test` in `apps/studio` to reproduce every number below.

## The problem, stated precisely

A creator films a talking-head reel on a phone and wants it cut, captioned
and posted. Doing that in a browser runs into one hard wall and one design
trap.

**The wall.** An HTML `<video>` element cannot be scrubbed frame by frame.
The patent literature is blunt about why: a browser "can navigate only to
every eighth frame in a video file", and only while that I-frame is still
buffered ([US 11,146,608](https://patents.google.com/patent/US11146608)).
Every browser editor built on `<video>` is approximate by construction, and
no amount of care in the UI fixes it. Frame-exact editing requires
[WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API).

**The trap.** Once you have WebCodecs you have two renderers: a canvas that
draws the preview and something server-side that writes the file. The
defect that defines a bad editor is the two disagreeing — a caption lower
in the export than in the preview, a crop that shifts, a zoom that ends
somewhere else. It is miserable to debug because both renderers are
individually correct. What is wrong is that each did its own arithmetic.

## Three mechanisms

### 1. One geometry solver, two backends

`src/lib/compose.ts` answers one question — *what is on screen at this
instant* — as explicit integers. Nothing else in the system computes a
rectangle.

- `src/lib/filtergraph.ts` turns those integers into ffmpeg filters
- `src/web/paint.ts` turns the same integers into canvas draw calls

The ffmpeg side emits **no** `force_original_aspect_ratio`, no `y=h-th-N`,
no `box=1`. Each of those asks ffmpeg to work out a number the browser
cannot see. Two design consequences, both deliberate:

- A caption's backing box is a **full-width band**, not a box hugging the
  glyphs. A hugging box needs measured text width, which cannot be made to
  agree by construction.
- Multi-line captions are **one layer per line** with an explicit top edge,
  so ffmpeg's own multi-line height calculation is never consulted.

**Measured.** `test/two-renderers.test.mts` parses the geometry back out of
the generated ffmpeg filter string *and* out of recorded canvas draw calls,
then compares:

```
ffmpeg crop 608x1080 @ 656,0 -> scale 1080x1920
canvas src 608x1080 @ 656,0 -> dst 1080x1920

ffmpeg y positions: 1384, 1458, 1532
canvas y positions: 1384, 1458, 1532

ffmpeg drawbox 1080x114 @ 0,1506
canvas fillRect 1080x114 @ 0,1506
```

`test/render-parity.test.mts` then renders a real mp4 and reads its pixels
back, with assets built so geometry is readable from colour alone — a
four-quadrant clip proves the crop offset, a flat screenshot locates the
letterbox edges to the pixel.

Parity detection is verified by **one-sided mutation**: moving the ffmpeg
overlay 40px while leaving the solver alone fails 2 checks. Moving *both*
correctly passes — that is parity holding, not a weak test.

### 2. The GOP is the unit that gets cached

WebCodecs requires decoding from a keyframe. The naive implementation —
reset, feed from the nearest keyframe, flush — is what a video-editor
author reported to the W3C as ["pretty much unusable"](https://github.com/w3c/webcodecs/issues/396),
because stepping back one frame re-decodes from hundreds of frames earlier.
They asked for a way to flush output without restarting from a keyframe.
There is none.

`src/web/seek.ts` answers it with two observations:

1. A decoder already positioned **earlier in the same GOP** than the target
   needs no reset. The expensive thing is the reset, not the decode.
2. The unit worth caching is the **GOP**, not the frame. Decoding a GOP's
   keyframe means decoding every frame in it anyway, so keeping them makes
   every later seek inside that GOP free — including backwards, the case the
   naive implementation handles worst.

**Measured.** Stepping backward frame by frame through a GOP — the exact
pattern reported as unusable:

```
thirty backward steps: 900 decodes naive, 30 cached
```

A **30× reduction**, and each frame decoded exactly once. Playing ten
seconds forward also decodes each frame exactly once.

### 3. Decoded frames are released

A `VideoFrame` holds a decoder buffer, usually in GPU memory, and the
garbage collector will not reclaim it. Every practitioner account says the
same: close each frame or exhaust memory, fast. A cache of unclosed frames
is not a cache with a leak, it is a leak with an index.

So the budget is in frames, eviction is least-recently-**used** by GOP, and
every evicted frame is closed on the way out. Closes are counted, because
"did we actually release them" is the property nobody checks.

**Measured.** A realistic drag across 13 positions under a 60-frame budget:

```
360 frames created, 300 closed, 60 still held
```

Every frame is either held or closed. None is lost.

**Held is not free, either.** The first real H.264 clip through the
browser froze the preview: a hardware decoder hands out frames from a
small pool -- eight on the machine this was found on -- and stops once all
are held. The GOP decoder held a whole GOP until `flush()` resolved, so
eight frames came out and `flush()` never did. Each decoded frame is now
copied to an `ImageBitmap` at preview size (longest edge 1280) and the
`VideoFrame` closed at once, with `flush()` waiting for the copies
(`studio-web/src/editor/media.ts`). Measured in Edge on a 1080×1920
phone-format clip with B-frames: scrubbing forward and back across a GOP
decodes, export carries the picture, and the exported file re-imports.

## Why not C++

People reach for C++/Wasm (Figma's path) when the browser has no primitive
fast enough. For video that stopped being true: `VideoDecoder` and
`VideoEncoder` expose the browser's **hardware** codecs. The expensive part
is already native and GPU-backed. Writing a compositor and codec in C++
means shipping megabytes of Wasm to do what `VideoEncoder` does natively —
one report measured a 1080p export dropping from
[10.3s to 2.6s](https://dev.to/whiztools_app/replacing-ffmpegwasm-with-webcodecs-a-1080p-export-from-103s-to-26s-40b8)
moving off ffmpeg.wasm.

**WebGPU was also rejected**, despite being the fashionable answer.
`importExternalTexture` can sample YUV
[zero-copy](https://developer.chrome.com/blog/new-in-webgpu-116), but MDN
lists it as not Baseline, and the gain is
[offset at encode](https://webrtchacks.com/video-frame-processing-on-the-web-webassembly-webgpu-webgl-webcodecs-webnn-and-webtransport/)
when the frame starts in GPU memory. A 2D canvas is universal and the export
is the deliverable.

Note that `docs/EDITOR-RENDERER.md`'s argument against GPU does **not**
apply here. It reasoned that a website's output *is* DOM, so a GPU renderer
means two renderers that disagree. A video editor's output is pixels. The
argument inverts; the conclusion happens to land in the same place for
different reasons.

## Lightweight, measured

The editor ships inside the React app in `apps/studio-web`, loaded lazily so
a visitor reading the landing page never downloads it:

```
assets/ProjectEditor-*.js   548.23 kB │ gzip: 146.81 kB   the editor route
assets/index-*.js           248.62 kB │ gzip:  80.30 kB   React, router, app shell
```

About **227 kB gzipped** of script to open the editor (2026-11-03 build),
including the Script panel, the media bin, the inspector and the whole
decode-and-export pipeline. For comparison,
ffmpeg.wasm is on the order of 25 MB. (The figure was 132 kB for the
plain-HTML prototype this replaced, before the Director existed; a size
quoted on a public page went stale that way once, so the landing page now
says "well under a megabyte" rather than a number.)

Almost all of it is `mediabunny`, which covers demuxing uploads *and* muxing
exports — WebCodecs does neither, which surprises everyone who starts here.
`zod` was removed from the browser bundle (13 kB gzipped) by generating the
theme defaults from the schema at build time, so they still cannot drift
(`scripts/emit-theme-defaults.mts`).

The bundle is audited for leaked server code: zero occurrences of `node:fs`,
`node:path`, `require(`, `process.env`, `zod`, or `drawtext`.

## Two bugs this architecture found

Both exited with code 0. Neither was visible in a screenshot.

**`crop` cannot change size per frame.** ffmpeg's `crop` filter evaluates
`w`/`h` once at configuration and only `x`/`y` per frame. A time-varying
crop size therefore freezes at its first value while the offsets keep
moving — rendering a photograph *panning sideways* at fixed magnification.
It looked deliberate. Caught only by rendering a square of known size and
measuring its width:

```
t=0.05s  solver predicts 356.4px, ffmpeg drew 355px
t=1.50s  solver predicts 379.6px, ffmpeg drew 379px
t=2.50s  solver predicts 395.6px, ffmpeg drew 395px
t=3.90s  solver predicts 417.8px, ffmpeg drew 417px
```

The fix puts the zoom in `scale` with `eval=frame`, between two
constant-size crops. This is the third formulation tried; `zoompan` with
`d=1` renders a dead still, because its `zoom` variable is the previous
frame's zoom within a d-sequence.

**A comment claiming a test that did not exist.** `photoZoom` and the
ffmpeg expression are two implementations of one formula, and the module
comment said they were "held together by a test that samples both". No such
test had been written. Writing it found the bug above.

## What is not built

| | status |
|---|---|
| Geometry solver, two backends | **built**, parity proven at pixel level |
| GOP cache + seek planner | **built**, 30× measured |
| Frame lifetime | **built**, zero leaks measured |
| Browser editor UI | **built**, React, checked in Edge at desktop and phone widths |
| AI Director: script to scene plan to cut | **built**; Cut needs no model, Write and Tighten use Claude Haiku behind the same validator |
| Forced alignment (script spelling, audio timing) | **built**, 61 checks incl. Devanagari; no recogniser feeds it yet |
| One served catalogue of plans, prices, languages | **built**; the browser bundle holds no copy |
| Server export with audio | **built**, verified −24 dB vs −91 dB |
| Browser export | **built**, and **silent by design** — see below |
| Caption engine (cue timing) | **built**, 65 checks, mutation-verified |
| Speech recogniser wired to it | not built — captions are paced from the script until one is |
| Dubbing provider | not built — `dubbing.ts` is the seam, 36 checks on the cost model |
| Accounts, plans, projects API | **built**, ownership isolation verified |
| Payments | **built** — Cashfree Orders, one prepaid month per payment, activated only from Cashfree's answer (status check or signed webhook), 56 checks; test mode without keys |
| Connections (Instagram, YouTube, TikTok outside India) | **built** against each platform's documented API, tokens AES-256-GCM at rest, 40 checks with fake platforms; **not yet run against a live account** |
| Insights | **built** — `lib/insights.ts`, the creator against their own median, minimum samples, 32 checks |
| Ideas | **built** — from the report by rules, or by Claude when keyed, each idea citing the creator's numbers |
| Auto-publishing | not built — waiting on Meta app review |
| Avatar generation (Mode B) | not built |

**The browser export is silent, deliberately.** A reel whose shots have
been reordered needs its audio re-timed to match, which means decoding,
resampling and re-muxing every segment. The server's ffmpeg path already
does that, verified. Shipping a browser export that silently dropped a
creator's voice would be worse than one that says so — so the browser
writes a draft for checking the cut, the server writes the deliverable, and
the UI states which is which.

**Verified visually, with limits.** The redesigned app was driven in installed
Edge through Playwright: landing, pricing, dashboard, billing and the editor
at 1440 and 390 wide, with the Director cutting a script into a timeline and
the playhead stepped into a shot. Zero console errors, and no horizontal
overflow at phone width. A second run put a phone-format H.264 clip through
WebCodecs: import, scrub, export and re-import of the export. Not covered:
footage from a real camera roll (the clip was generated), and Safari.

**Browser support** is narrower than the rest of this product. WebCodecs
video needs Chrome/Edge 94+ or Safari 16.4+, but `AudioEncoder` landed only
in **Safari 26** — the real floor for an audio-carrying editor. The spec is
still a Working Draft. `canExport()` checks at runtime and says so rather
than failing mid-export.

## Sources

- [US 11,146,608 — Frame-accurate video seeking via web browsers](https://patents.google.com/patent/US11146608) · [continuation](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11722542) — the every-eighth-frame limit
- [W3C WebCodecs issue #396](https://github.com/w3c/webcodecs/issues/396) — the seek cost, from someone building an editor · [#105](https://github.com/w3c/webcodecs/issues/105) — timestamp precision
- [Chromium 424836493](https://issues.chromium.org/issues/424836493) — strict key-frame detection, why `verifyKeyPackets` is on
- [Using the WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API/Using_the_WebCodecs_API) · [The WebCodecs Handbook](https://www.freecodecamp.org/news/the-webcodecs-handbook-native-video-processing-in-the-browser/)
- [Replacing ffmpeg.wasm with WebCodecs](https://dev.to/whiztools_app/replacing-ffmpegwasm-with-webcodecs-a-1080p-export-from-103s-to-26s-40b8) — the 10.3s → 2.6s measurement
- [importExternalTexture](https://developer.mozilla.org/docs/Web/API/GPUDevice/importExternalTexture) · [WebGPU in Chrome 116](https://developer.chrome.com/blog/new-in-webgpu-116) · [Video frame processing on the web](https://webrtchacks.com/video-frame-processing-on-the-web-webassembly-webgpu-webgl-webcodecs-webnn-and-webtransport/)
- [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) — the interchange format the export writes
- [Figma's Wasm/GPU architecture](https://madebyevan.com/figma/webassembly-cut-figmas-load-time-by-3x) — the case that does need C++, and why this is not it
