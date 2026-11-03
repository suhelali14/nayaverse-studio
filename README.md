# Studio

Script, cut, caption and finish vertical video in the browser.

A creator writes or pastes a script (or has one written and steers it line
by line); Studio splits it into scenes, puts their clips under the lines
they belong to and captions every word. They finish on a multi-track
timeline -- looks, speed, push, fades, music on the beat, AI-made shots --
and export up to 4K from their own browser. Their footage never leaves
their machine; the edit is saved as they go.

Made to run at **nayaverse.studio**; see [docs/DEPLOY.md](docs/DEPLOY.md).

## The apps

| | |
|---|---|
| `apps/studio` | the engine: timeline, scenes, captions, the editor's pass, rendering. Pure TypeScript, tested without a browser. |
| `apps/studio-api` | the API (Fastify): accounts, plans, saved edits, AI through one gateway (Claude, Runway), payments, connected accounts. |
| `apps/studio-web` | the web app (React, Vite): the editor, the dashboard and the website. |

## Run it

Node 22.

```bash
npm install
cp apps/studio-api/.env.example apps/studio-api/.env   # add an ANTHROPIC_API_KEY for the AI features
npm run dev:api     # http://localhost:4300
npm run dev:web     # http://localhost:5179, forwards /api to the API
```

```bash
npm run typecheck   # all three apps
npm test            # engine and API, ~1,200 checks
```

The editor's own browser tests (Playwright against real Edge) live outside
this repository's CI; the unit and API suites above run on every push.

## Deploy

`main` deploys itself: the API to a server as a Docker image, the web app
to Vercel. One-time setup and how it works: [docs/DEPLOY.md](docs/DEPLOY.md).

## Keys and data

No key, token or password is in this repository. Each setting is documented
in `apps/studio-api/.env.example` and set on the server in
`/srv/studio/studio-api.env`.
