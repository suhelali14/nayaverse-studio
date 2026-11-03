# Deploying Studio

```
nayaverse.studio            -> Vercel        the web app (static)
api.nayaverse.studio        -> GoDaddy VPS   nginx -> the Studio API container
```

The API runs on the same GoDaddy server as the clinic stack, as its own
Docker Compose project under `/srv/studio`. The web app is a static build on
Vercel that calls the API across domains (the API allows only the origins in
its `CORS_ORIGINS`).

## What it costs the shared server

Studio's server is light, because the heavy work happens elsewhere:

| Work | Where it runs | Load on the server |
|---|---|---|
| Editing, previews, exports up to 4K | the creator's browser (WebCodecs) | none |
| AI writing, ideas, notes | Anthropic's servers | a waiting HTTPS request |
| AI video | Runway's servers | a waiting request, then one download per clip |
| The API itself | the container | ~100-150MB RAM, near-zero CPU at rest |
| Saved edits, accounts | a JSON file in the volume | small: an edit is ~10-100KB |
| Footage uploads, AI clips | the volume | **disk**: up to 200MB per upload |

The container is capped at **half a CPU and 512MB** (`deploy/docker-compose.yml`),
so a burst of Studio traffic slows Studio and never a clinic's front desk.
On the smallest plan (1 vCPU / 2GB) that leaves the clinics their share.

Watch the disk, not the CPU: `docker system df` and `df -h /var/lib/docker`.
Server-side transcription, dubbing and rendering are not wired to any
provider yet; if they ever run ffmpeg on this box, revisit the CPU cap.

## One-time setup

### 1. DNS (GoDaddy, the nayaverse.studio domain)

| Type | Name | Value |
|---|---|---|
| A | `api` | the server's IPv4 address |
| A | `@` | 76.76.21.21 (Vercel) |
| CNAME | `www` | cname.vercel-dns.com |

Vercel shows the exact records for the apex and `www` when you add the
domain to the project; use what it shows if it differs from the above.

### 2. The server

Over SSH, on the box that already runs the clinic stack:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/nayaverse-studio/main/deploy/server/bootstrap.sh -o studio-bootstrap.sh
less studio-bootstrap.sh
sudo CERTBOT_EMAIL=you@example.com bash studio-bootstrap.sh <owner>/nayaverse-studio
```

It creates `/srv/studio`, clones this repository, writes
`/srv/studio/studio-api.env` once (with a fresh JWT secret and token key),
adds the nginx site for `api.nayaverse.studio` and asks certbot for HTTPS.
Then put your keys in `/srv/studio/studio-api.env` (`ANTHROPIC_API_KEY`
at least; see `apps/studio-api/.env.example` for every setting).

### 3. GitHub (this repository, Settings > Secrets and variables > Actions)

Secrets -- the same four the clinic repository uses, so copy them across:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | the server's IP |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | the deploy user's private key |
| `DEPLOY_HOST_KEY` | `ssh-keyscan -H <server-ip>` |
| `VERCEL_TOKEN` | vercel.com > Account Settings > Tokens |
| `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | from `.vercel/project.json` after `npx vercel link` in `apps/studio-web` |

Variable (the Variables tab -- it is public and ends up in the site):

| Variable | Value |
|---|---|
| `STUDIO_API_URL` | `https://api.nayaverse.studio` |

Also: Settings > Environments > create `production` (the deploy jobs use it,
so you can require approval there if you want a human to press go).

### 4. Vercel

New project from this repository, root directory `apps/studio-web`,
framework Vite. Add the domains `nayaverse.studio` and `www.nayaverse.studio`.
Git deployments are turned off in `vercel.json`: the workflow deploys only
builds that passed CI.

## Every deploy after that

Push to `main`. CI runs (typecheck, ~1,200 tests, both builds, the bundle
must start). Then:

- **Deploy API** builds the image once, pushes it to ghcr.io, and on the
  server pulls it, starts it, waits for `/health`, and rolls back to the
  last good image if it does not come up.
- **Deploy web** builds the site with `STUDIO_API_URL` baked in, deploys it
  to Vercel, and fails if the build does not contain that address.

By hand on the server:

```bash
/srv/studio/repo/deploy/server/deploy.sh status     # what runs, and its health
/srv/studio/repo/deploy/server/deploy.sh restart    # after editing studio-api.env
```

Redeploy an earlier image: Actions > Deploy API > Run workflow, with the
image tag from an earlier run.

## Backups

Everything the API keeps is in the `studio_studio-data` Docker volume: the
JSON store (accounts, projects, saved edits) and uploaded or generated video.
Back it up with the clinic backups:

```bash
docker run --rm -v studio_studio-data:/data -v /srv/backups:/out alpine \
  tar czf /out/studio-$(date +%F).tgz -C /data .
```

Creators' own footage is not on the server: it stays in their browser, and a
saved edit refers to it by name.
