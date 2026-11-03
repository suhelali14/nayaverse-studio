#!/usr/bin/env bash
# Start the Studio API from an image, check it is healthy, and fall back to
# the last good image if it is not. Run by the Deploy API workflow over SSH
# as the deploy user, with IMAGE_TAG set:
#
#   IMAGE_TAG=ghcr.io/<owner>/nayaverse-studio/api:<sha> deploy.sh
#
# or by hand:
#   deploy.sh restart     re-read studio-api.env with the running image
#   deploy.sh status      what is running, and its health
set -euo pipefail

cd /srv/studio/repo
COMPOSE=(docker compose -f deploy/docker-compose.yml)
LAST=/srv/studio/last-good-image
PORT="${STUDIO_PORT:-4310}"

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

case "${1:-deploy}" in
  status)
    IMAGE_TAG="$(cat "$LAST" 2>/dev/null || echo unknown)" "${COMPOSE[@]}" ps
    curl -fsS -m 3 "http://127.0.0.1:$PORT/health" && echo
    exit 0
    ;;
  restart)
    export IMAGE_TAG="$(cat "$LAST")"
    "${COMPOSE[@]}" up -d --force-recreate
    healthy && echo "Restarted $IMAGE_TAG, healthy." || { echo "Unhealthy after restart:"; "${COMPOSE[@]}" logs --tail 60 api; exit 1; }
    exit 0
    ;;
esac

: "${IMAGE_TAG:?IMAGE_TAG is not set}"
[ -f /srv/studio/studio-api.env ] || { echo "/srv/studio/studio-api.env is missing. Run deploy/server/bootstrap.sh first."; exit 1; }

echo "Pulling $IMAGE_TAG"
docker pull --quiet "$IMAGE_TAG"
export IMAGE_TAG
"${COMPOSE[@]}" up -d

if healthy; then
  echo "$IMAGE_TAG" > "$LAST"
  echo "Studio API healthy on $IMAGE_TAG"
  # Keep the current and previous images; older ones only fill the disk.
  docker image prune -f --filter "label!=keep" >/dev/null 2>&1 || true
  exit 0
fi

echo "The new image did not become healthy. Its last log lines:"
"${COMPOSE[@]}" logs --tail 80 api || true
if [ -f "$LAST" ]; then
  previous="$(cat "$LAST")"
  echo "Rolling back to $previous"
  IMAGE_TAG="$previous" "${COMPOSE[@]}" up -d
  healthy && echo "Rolled back; the previous image is serving." || echo "The previous image is not healthy either."
fi
exit 1
