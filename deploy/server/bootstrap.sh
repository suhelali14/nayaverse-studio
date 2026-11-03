#!/usr/bin/env bash
# One-time setup of the Studio API on the GoDaddy server that already runs
# the clinic stack (Docker, nginx and certbot are installed by its own
# bootstrap). Run once, as root, over SSH:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/nayaverse-studio/main/deploy/server/bootstrap.sh -o studio-bootstrap.sh
#   less studio-bootstrap.sh          # read it before running it
#   sudo bash studio-bootstrap.sh <owner>/nayaverse-studio
#
# What it does, and nothing else:
#   1. /srv/studio, owned by the deploy user the pipeline logs in as
#   2. a clone of this repository there, for the compose file and scripts
#   3. /srv/studio/studio-api.env, created once with a fresh JWT secret --
#      never overwritten, so re-running cannot lose your keys
#   4. the nginx site for api.nayaverse.studio, then an HTTPS certificate
#
# It does not start the API: the first push to main does, through the
# Deploy API workflow, with an image built and tested in CI.
set -euo pipefail

REPO="${1:?usage: bootstrap.sh <owner>/<repo>}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
DOMAIN="${STUDIO_API_DOMAIN:-api.nayaverse.studio}"
WEB="${STUDIO_WEB_URL:-https://nayaverse.studio}"

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }
id "$DEPLOY_USER" >/dev/null 2>&1 || { echo "No '$DEPLOY_USER' user. The clinic bootstrap creates it; run that first."; exit 1; }
command -v docker >/dev/null || { echo "Docker is not installed."; exit 1; }
command -v nginx >/dev/null || { echo "nginx is not installed."; exit 1; }
id -nG "$DEPLOY_USER" | grep -qw docker || { echo "'$DEPLOY_USER' is not in the docker group."; exit 1; }

echo "== /srv/studio"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 750 /srv/studio

echo "== repository"
if [ -d /srv/studio/repo/.git ]; then
  sudo -u "$DEPLOY_USER" git -C /srv/studio/repo fetch --quiet origin
else
  sudo -u "$DEPLOY_USER" git clone --quiet "https://github.com/$REPO.git" /srv/studio/repo
fi

echo "== settings"
ENV_FILE=/srv/studio/studio-api.env
if [ -f "$ENV_FILE" ]; then
  echo "$ENV_FILE exists; left as it is."
else
  umask 077
  cat > "$ENV_FILE" <<EOF
# Studio API settings. Read by the container; never committed anywhere.
# After editing, apply with: /srv/studio/repo/deploy/server/deploy.sh restart
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 48)
TRUST_PROXY=1
PUBLIC_WEB_URL=$WEB
PUBLIC_API_URL=https://$DOMAIN
CORS_ORIGINS=$WEB,${WEB/https:\/\//https://www.}
STUDIO_SIMULATE_JOBS=false

# AI writing, ideas and the editor's notes. Without it those features say
# they are not set up; the editor itself works.
ANTHROPIC_API_KEY=
STUDIO_WRITER_MODEL=

# AI video (billable per second). Empty keeps it off.
RUNWAY_API_KEY=

# Payments. Both or neither.
CASHFREE_APP_ID=
CASHFREE_SECRET_KEY=
CASHFREE_ENV=sandbox

# Connected accounts. TOKEN_ENCRYPTION_KEY seals their tokens at rest.
TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=

# Operators: comma-separated emails.
STUDIO_ADMIN_EMAILS=
EOF
  chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created $ENV_FILE with a fresh JWT secret. Add your API keys to it."
fi

echo "== nginx"
install -m 644 /srv/studio/repo/deploy/nginx/api.nayaverse.studio.conf "/etc/nginx/sites-available/$DOMAIN.conf"
sed -i "s/server_name api.nayaverse.studio;/server_name $DOMAIN;/" "/etc/nginx/sites-available/$DOMAIN.conf"
ln -sf "/etc/nginx/sites-available/$DOMAIN.conf" "/etc/nginx/sites-enabled/$DOMAIN.conf"
nginx -t
systemctl reload nginx

echo "== HTTPS"
if getent hosts "$DOMAIN" >/dev/null; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "${CERTBOT_EMAIL:-admin@$DOMAIN}" \
    || echo "certbot did not finish. Check that $DOMAIN points at this server, then: sudo certbot --nginx -d $DOMAIN"
else
  echo "$DOMAIN does not resolve yet. Add its DNS record, then run: sudo certbot --nginx -d $DOMAIN"
fi

echo
echo "Done. Next: add your keys to $ENV_FILE, then push to main (or run the"
echo "Deploy API workflow) to start the API."
