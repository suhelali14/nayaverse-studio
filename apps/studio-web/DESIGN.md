---
name: Studio
description: A professional editor for vertical reels -- script, cut, captions and dub on one frame-exact timeline -- with a light website in front of a dark app.
colors:
  # :root (light room: website, sign-in). Source: src/index.css, RGB triplets.
  ground: "rgb(255 255 255)"
  panel: "rgb(255 255 255)"
  panel-2: "rgb(246 246 245)"
  panel-3: "rgb(238 238 236)"
  line: "rgb(232 232 230)"
  line-strong: "rgb(212 212 209)"
  ink: "rgb(20 20 20)"
  ink-2: "rgb(74 74 74)"
  ink-3: "rgb(110 110 110)"
  accent: "rgb(214 39 24)"
  accent-ink: "rgb(255 255 255)"
  accent-soft: "rgb(253 236 234)"
  accent-deep: "rgb(184 30 17)"
  select: "rgb(214 39 24)"
  monitor: "rgb(17 17 18)"
  good: "rgb(22 120 72)"
  good-soft: "rgb(229 244 235)"
  warn: "rgb(150 96 0)"
  warn-soft: "rgb(255 244 214)"
  bad: "rgb(190 36 24)"
  bad-soft: "rgb(253 236 234)"
  kind-clip: "rgb(46 92 150)"
  kind-photo: "rgb(34 112 101)"
  kind-asset: "rgb(98 78 160)"
  kind-solid: "rgb(110 64 130)"
  cue: "rgb(214 160 40)"
  cue-ink: "rgb(28 22 8)"
  # :root[data-theme='dark'] (dark room: every /app route).
  ground-dark: "rgb(12 12 13)"
  panel-dark: "rgb(21 21 23)"
  panel-2-dark: "rgb(29 29 32)"
  panel-3-dark: "rgb(38 38 42)"
  line-dark: "rgb(37 37 41)"
  line-strong-dark: "rgb(56 56 62)"
  ink-dark: "rgb(236 236 238)"
  ink-2-dark: "rgb(174 174 181)"
  ink-3-dark: "rgb(136 136 144)"
  accent-dark: "rgb(214 39 24)"
  accent-ink-dark: "rgb(255 255 255)"
  accent-soft-dark: "rgb(58 24 21)"
  accent-deep-dark: "rgb(232 56 40)"
  select-dark: "rgb(240 74 58)"
  monitor-dark: "rgb(8 8 9)"
  good-dark: "rgb(74 196 126)"
  good-soft-dark: "rgb(18 46 31)"
  warn-dark: "rgb(232 176 52)"
  warn-soft-dark: "rgb(50 39 14)"
  bad-dark: "rgb(255 112 98)"
  bad-soft-dark: "rgb(56 22 20)"
  kind-clip-dark: "rgb(44 88 146)"
  kind-photo-dark: "rgb(30 104 94)"
  kind-asset-dark: "rgb(92 74 152)"
  kind-solid-dark: "rgb(96 58 116)"
  cue-dark: "rgb(200 150 38)"
  cue-ink-dark: "rgb(24 18 6)"
typography:
  display: { fontFamily: "Archivo Variable, Mukta, system-ui, sans-serif", fontSize: "3.75rem", fontWeight: 700, lineHeight: "4rem", letterSpacing: "-0.028em" }
  headline: { fontFamily: "Archivo Variable, Mukta, system-ui, sans-serif", fontSize: "3rem", fontWeight: 700, lineHeight: "3.3rem", letterSpacing: "-0.028em" }
  title: { fontFamily: "Archivo Variable, Mukta, system-ui, sans-serif", fontSize: "1.75rem", fontWeight: 600, lineHeight: "2.15rem", letterSpacing: "-0.02em" }
  body: { fontFamily: "Archivo Variable, Mukta, system-ui, sans-serif", fontSize: "0.9375rem", fontWeight: 400, lineHeight: "1.45rem" }
  body-ui: { fontFamily: "Archivo Variable, Mukta, system-ui, sans-serif", fontSize: "0.8125rem", fontWeight: 500, lineHeight: "1.25rem" }
  label: { fontFamily: "Archivo Variable, Mukta, system-ui, sans-serif", fontSize: "0.75rem", fontWeight: 400, lineHeight: "1.05rem" }
  micro: { fontFamily: "Archivo Variable, Mukta, system-ui, sans-serif", fontSize: "0.6875rem", fontWeight: 600, lineHeight: "1rem" }
  figures: { fontFamily: "Archivo Variable, Mukta, system-ui, sans-serif", fontFeature: "tnum" }
rounded:
  sm: "3px"
  DEFAULT: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
spacing:
  gutter-phone: "20px"
  gutter: "32px"
  panel: "16px"
  band: "80px"
  band-wide: "112px"
components:
  button-primary: { backgroundColor: "{colors.accent}", textColor: "{colors.accent-ink}", rounded: "{rounded.md}", padding: "0 16px", height: "40px" }
  button-primary-hover: { backgroundColor: "{colors.accent-deep}" }
  button-secondary: { backgroundColor: "{colors.panel-2}", textColor: "{colors.ink}", rounded: "{rounded.md}", padding: "0 16px", height: "40px" }
  button-secondary-hover: { backgroundColor: "{colors.panel-3}" }
  button-ghost: { textColor: "{colors.ink-2}", rounded: "{rounded.md}", padding: "0 16px", height: "40px" }
  button-ghost-hover: { backgroundColor: "{colors.panel-2}", textColor: "{colors.ink}" }
  button-danger: { textColor: "{colors.bad}", rounded: "{rounded.md}", padding: "0 16px", height: "40px" }
  button-danger-hover: { backgroundColor: "{colors.bad-soft}" }
  button-inverse: { backgroundColor: "{colors.ink}", textColor: "{colors.ground}", rounded: "{rounded.md}", padding: "0 16px", height: "40px" }
  icon-button: { textColor: "{colors.ink-2}", rounded: "{rounded.md}", size: "36px" }
  input: { backgroundColor: "{colors.panel}", textColor: "{colors.ink}", rounded: "{rounded.md}", padding: "8px 12px", height: "40px" }
  panel: { backgroundColor: "{colors.panel}", rounded: "{rounded.lg}" }
  panel-head: { textColor: "{colors.ink}", typography: "{typography.body-ui}", padding: "0 16px", height: "40px" }
  badge-neutral: { backgroundColor: "{colors.panel-3}", textColor: "{colors.ink-2}", typography: "{typography.micro}", rounded: "{rounded.DEFAULT}", padding: "0 6px", height: "20px" }
  badge-warn: { backgroundColor: "{colors.warn-soft}", textColor: "{colors.warn}", typography: "{typography.micro}", rounded: "{rounded.DEFAULT}", padding: "0 6px", height: "20px" }
  segmented-on: { backgroundColor: "{colors.panel-3}", textColor: "{colors.ink}", rounded: "{rounded.DEFAULT}", height: "28px" }
  product-frame: { backgroundColor: "{colors.ink}", rounded: "{rounded.xl}" }
---

# Design System: Studio

## Overview

**Creative North Star: "The Professional Bench"**

Studio is a tool, not a theme. The editor is built from the parts a creator already trusts in CapCut, Descript or Resolve: a tool rail, a library panel, a viewer, a contextual inspector and a multi-track timeline. The brand lives in one red and in precise details; nothing on screen is decoration.

There are two rooms on one set of token names. The website and sign-in are light (white ground, near-black ink) because they are read in daylight by someone deciding. Every `/app` route is dark neutral graphite because its job is judging pictures, and a bright frame changes how footage reads. `RouteTheme` in `src/App.tsx` sets `data-theme="dark"` on `<html>` before paint; components never choose a room. Density is a working app's: 13px UI text, 40px rows, hairline-divided panels.

Type is Archivo at normal width for everything, with tabular figures wherever a number sits in a column, and Mukta taking Devanagari glyph by glyph. The user ruled out dark navy with a blue glow, and cream paper with a serif.

History: the earlier world, On Air, was retired on 2026-11-03 because the user said it looked machine-made.

**Key Characteristics:**
- Light website, dark graphite app, one set of token names.
- Red is the only saturated colour; clip kinds and caption cues get muted data hues on the timeline only.
- Archivo at 100% width, a fixed rem scale, tabular figures for time and money.
- Controls 6px, cards 8px, product frames 12px.
- Shadows only on things that float.

## Colors

Neutral graphite and white with a single broadcast red; every other hue is either a status or a timeline data colour. Values: frontmatter, light key and `-dark` key.

### Primary
- **Studio Red** (`accent`): the primary action (one per view), the playhead, the progress and usage meter fill, the check marks in website feature lists, the live cue's timecode, the logo tile. Same red in both rooms.
- **Red Ink** (`accent-ink`): text and icons on red.
- **Red Deep** (`accent-deep`): primary hover. Darker in the light room, lighter in the dark room, so hover always moves away from the ground.
- **Red Wash** (`accent-soft`): the `accent` badge ground (a reel that is Rendering).
- **Select** (`select`): the keyboard focus ring, focused field borders and text selection. Brighter in the dark room so the ring holds contrast on graphite.

### Neutral
- **Ground** (`ground`): the page. **Panel** (`panel`): sidebars, tool panels, inspector, timeline, cards. **Panel 2** (`panel-2`): recessed fills -- secondary buttons, hovered rows, muted website bands, the footer, skeletons. **Panel 3** (`panel-3`): active nav item, pressed segment, neutral badge, meter track.
- **Line** (`line`): every divider and panel border. **Line Strong** (`line-strong`): control borders, toast and checkout borders, ruler ticks, scrollbar thumb.
- **Ink** (`ink`): headings and primary text. **Ink 2** (`ink-2`): body copy, ledes, idle nav. **Ink 3** (`ink-3`): hints, metadata, placeholders, counts.
- **Monitor** (`monitor`): the viewer well behind the canvas, darker than any panel in either room.

### Status
- **Good / Warn / Bad** with their `-soft` washes: badges, toasts, meters past threshold, inline alerts. Warn also marks **Coming soon** and working states.

### Timeline data
- **Kind Clip** (blue, video), **Kind Photo** (teal), **Kind Asset** (violet, image), **Kind Solid** (plum, text card): clip fills on the video track and thumbnail placeholders. **Cue** (amber) with **Cue Ink**: caption chips on the captions track.

**The One Red Rule.** Red is the only saturated colour in the chrome. A second accent hue never enters; the kind and cue hues stay inside the timeline and thumbnails.

**The One File Rule.** Every colour is an RGB triplet defined twice in `src/index.css` and consumed as `rgb(var(--x) / alpha)` through Tailwind names. A component never carries a hex or rgb literal.

**The Never Alone Rule.** A status colour always travels with a word or an icon: badges carry their label, toasts their icon, the tool-rail dot a screen-reader "in progress" or "done".

## Typography

**Display Font:** Archivo Variable (with Mukta, system-ui, sans-serif)
**Body Font:** the same stack. Devanagari falls to Mukta (500, 700, 800) by unicode-range, so a Hindi word inside an English sentence needs no span.

**Character:** one plain, slightly wide grotesque at normal width; hierarchy comes from size and weight (400, 500, 600, 700), never from width, case or tracking.

### Hierarchy
- **Hero** (760, fluid `clamp(2.6rem, 1.4rem + 3.9vw, 5rem)`, line-height 0.96, width 112%, -0.04em): the website hero h1 and the dark close, `.display-hero`.
- **Display** (700, width 106%, -0.032em): website and sign-in headings, `.display` class.
- **Headline** (700, 2.25rem below sm / 3rem from sm, -0.028em): website section h2 and the dark close.
- **Title** (600, 1.75rem, -0.02em): website feature-row h3; the same tracking on large numbers (Insights figures, plan prices) and the auth panel line. Inside the app, page titles are 0.9375rem 600.
- **Body** (400, 0.9375rem / 1.45rem, max 58ch): reading text; website ledes step up to 1.125rem relaxed.
- **Body UI** (500-600, 0.8125rem / 1.25rem): buttons, nav, field labels, panel heads.
- **Label** (400-500, 0.75rem): hints, metadata, inspector rows, timeline headers, xs buttons.
- **Micro** (500-600, 0.6875rem): badges, tool-rail labels, ruler numbers, cue chips.

**The Fixed Scale Rule.** Sizes come from the ten-step rem scale in `tailwind.config.js` (2xs to 5xl, about 1.2 apart); no fluid type, no px font sizes.

**The Website Exception.** Two lines on the website, the hero and the close, are fluid and set Archivo opened to 112% width, which gives them the set of a film title without changing face; website headings open to 106%. Width stays at 100% everywhere inside the app.

**The Tabular Rule.** Every timecode, duration, count, percentage and price is set with tabular figures (`<time>` and `.tabular` get them globally).

## Layout

- **Website:** `.shell` is the page edge (max 1200px, 20px gutter, 32px from sm). Pages are full-width **bands** of 80px vertical padding (112px from sm) alternating `ground` and muted `panel-2`. The hero is centred: one sentence, a lede, primary plus secondary call, the catalogue price line, then a real editor capture in a product frame half-overlapping a muted band. Feature rows alternate copy (5fr) and capture (7fr). The close is a `bg-ink` band with one call. Sticky 64px header with backdrop blur; anchors clear it with 80px scroll padding.
- **App shell (every signed-in screen except the editor):** a 240px sidebar from lg (logo, full-width primary New reel, icon-plus-label nav, account row at the foot); below lg a 288px drawer over a 60% black scrim. A sticky 56px header holds the page title and its actions; content max 1280px with 16/24/32px gutters.
- **Editor (full window, own top bar):** 48px top bar (back, mark, reel name and length, Export draft); 64px tool rail; 312px tool panel with every tool kept mounted; fluid viewer on `monitor` with a 48px transport bar; 288px inspector; the timeline across the bottom (40px toolbar, 96-112px track headers, 24px ruler, 64px video track, 36px captions track). Below lg the regions stack: viewer, timeline, horizontal rail, panel, inspector.
- **Rhythm:** panel content pads 16px; heading rows are 40px; lists divide with `line` rules rather than gaps.

## Elevation & Depth

Depth is tonal: `ground`, then `panel`, then `panel-2`/`panel-3`, separated by hairlines. Shadows exist only for things that float above the page.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 8px 24px -6px rgb(0 0 0 / 0.28), 0 2px 6px -2px rgb(0 0 0 / 0.2)`): toasts, the mobile nav drawer, menus.
- **Frame** (`box-shadow: 0 30px 60px -20px rgb(20 20 20 / 0.35), 0 12px 24px -12px rgb(20 20 20 / 0.25)`): product captures on the website and auth screens.

**The Float-Only Rule.** A shadow means the thing is above the page. Cards, panels and tiles sit flat on a hairline or an inset ring.

## Shapes

One small corner set, replaced (not extended) in Tailwind: controls, nav items, skeletons and timeline clips 6px; panels, reel tiles, empty states and toasts 8px; product frames and the checkout card 12px; badges, segments and cue chips 4px; avatars, meters and the play button full. Borders are 1px; tiles and clips use inset rings so a selection never changes width. The playhead is a 2px red line under a pentagon cap.

## Components

### Buttons
- **Shape:** gently rounded (6px); sizes xs 28px, sm 32px, md 40px (default), lg 48px; icon 36px and icon-sm 28px squares.
- **Primary:** red, semibold; the one main action of a view (New reel, Export draft, Dub this reel, Pay, Get started).
- **Secondary (default):** `panel-2` with a strong hairline; everyday actions.
- **Ghost:** no fill, `ink-2`; toolbars, Sign in, Keep, icon buttons.
- **Danger:** `bad` text on a 40% `bad` border; destructive actions, always after a confirm step.
- **Inverse:** ink fill on the light website, the second action beside red (Get started in the header, Open Studio).
- **States:** colour transitions at 150ms; disabled at 45% opacity. An async `onClick` shows a spinner, sets `aria-busy` and blocks re-entry; never thread a saving flag by hand. `IconButton` requires `label`, used as `aria-label` and `title` (put the shortcut in it: "Split at playhead (S)").

### Badges
- **Style:** 20px, 4px corners, micro semibold, tinted wash with tone text: neutral, good, warn, bad, accent.
- **Use:** only exceptions wear colour (Rendering, Ready, Failed); ordinary states stay neutral. **Coming soon** is always `warn`.

### Panels
- **Panel:** 8px, `line` border, `panel` fill, optional `panel-head` (40px, 13px semibold sentence case, a quiet count on the right).
- **Empty:** dashed `line-strong` box, a title and a sentence that says what to do next, optional action.
- **Skeleton:** `panel-2` shaped like the content it replaces, a 1.4s sweep, `role="status"` with one label.

### Inputs / Fields
- **Style:** 40px (select compact 32px), 6px, `panel` fill, `line-strong` border, `ink-3` hover border.
- **Focus:** border turns `select` with a 2px `select` ring at 25%.
- **Error / Disabled:** `bad` border and `aria-invalid`; `Field` always reserves its hint/error line so the form never reflows. Disabled at 60%.
- **Select** is native with a drawn chevron. **Segmented** is a `panel-2` track of `aria-pressed` buttons, the pressed one on `panel-3`.

### Navigation
- **Website header:** logo, 13px medium links in `ink-2` to `ink` on hover, ghost Sign in and inverse Get started; below md a menu button opening 44px rows, scroll-locked, closed by Escape and by navigation.
- **App sidebar:** 36px rows, icon and label; active is `panel-3` with `ink`, idle `ink-2` with a `panel-2` hover.
- **Editor tool rail:** 56px icon-over-label buttons; active `panel-3`; a 6px dot top-right, `warn` pulsing while working, `good` when done.

### Reel tile
A 4:5 tile on `panel-2` with an inset `line` ring (`bad` at 60% when broken), a status badge top-left, the duration bottom-right, download and delete revealed on hover or focus (always visible on coarse pointers). Under it: title, then language, relative time and extras in `ink-3`; open jobs show a spinner line and a 4px red progress bar.

### Meter
A 6px rounded track on `panel-3`, a label and tabular readout above. Red until 90%, `warn` from 90%, `bad` past 100%; one threshold for every meter. Carries `role="meter"` with the readout as its value text.

### Checkout
A 12px `line-strong` card: plan and month, a tabular price breakdown from the served catalogue, the phone field, a full-width large primary "Pay" with the total, one line naming the payment methods.

### Timeline
Track headers on the left; a ruler with six to twelve labels; clips filled by kind with a thumbnail, label and duration, 10px trim handles; amber cue chips with the live cue ringed in `ink`; the red playhead. The selected clip takes a 2px inset `ink` ring.

### Toasts
Bottom-right, `panel-2`, `line-strong` border, Float shadow, an icon per tone. Confirmations last 3.5s, errors 9s and are announced assertively; duplicates collapse.

## Motion (website)

One authored moment and nothing hidden. The hero is a three.js scene of the sample reel's five real frames standing over that cut's timeline, in the clip-kind tokens; a red playhead crosses at real speed and lifts each scene's frame. It loads after idle, draws only on screen, pauses from a button and stops completely when paused, renders once under reduced motion, and falls back to the same picture in HTML without WebGL or on Save-Data. Everything else moves like a timeline: the header's ruler carries a playhead at scroll position, the editor capture settles flat as it arrives, the workflow stage follows the current step by zooming the real editor capture, and the close runs the reel's frames as a film strip. No section fades in, so a crawler, a print or a full-page capture never meets an invisible page. Ease out only (`[0.16, 1, 0.3, 1]`), no bounce.

## Do's and Don'ts

### Do:
- **Do** take every colour from the token names; retune either room in `src/index.css` only.
- **Do** let `RouteTheme` choose the room: anything under `/app` is dark, everything else light.
- **Do** keep one red primary per view; use inverse ink for the second call on the website.
- **Do** use tabular figures for every number in a column, and the fixed rem scale for every size.
- **Do** show the keyboard focus ring (2px `select`, 2px offset) and leave the mouse click without one.
- **Do** make phone-menu targets at least 44px, and keep inputs at 16px on coarse pointers so iOS does not zoom.
- **Do** honour reduced motion: the global override cuts animations and transitions to 0.01ms and turns off smooth scroll.
- **Do** read prices, plans, regions, taxes and languages from `GET /api/catalogue`; never type one into a component.
- **Do** state what a thing does or what to do next ("Select a clip to edit it.") and mark anything not switched on with a `warn` **Coming soon** badge.
- **Do** compare a creator only with their own earlier numbers ("vs previous 30 days").

### Don't:
- **Don't** introduce a second accent hue, a gradient or a glow; the skeleton's neutral sweep is a loading device, not decoration.
- **Don't** put a shadow on anything that does not float.
- **Don't** use a radius outside the scale or an arbitrary radius value.
- **Don't** set type condensed, in tracked capitals, or as an eyebrow label above a heading; the heading carries itself.
- **Don't** narrate the product in its copy: no honesty disclaimers, no notes about how it was made, no explaining the interface to itself.
- **Don't** tick a feature that is not live, or invent customers, testimonials, ratings, counts or industry benchmarks.
- **Don't** restyle the reel's own captions with app chrome; inside the reel they keep the engine treatment (outlined white over footage, a band over screenshots), set in Inter.
- **Don't** build dark navy with a blue glow, or cream paper with a serif.
