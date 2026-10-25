#!/bin/sh
# Build and restart the container. After a push to master, GitHub Actions runs
# `git pull && ./deploy.sh` here (set in the VPS authorized_keys, see doc/deploy.md).
# Manual deploy: git pull && ./deploy.sh
set -eu
cd "$(dirname "$0")"

docker compose build

# Don't restart from :58 to :02. The new container needs time to log in before it schedules
# the post, and the :00 round with retries can take a minute or two. A missed post is not resent
near_hour() {
  case $(TZ=Asia/Shanghai date +%M) in
    58|59|00|01|02) return 0 ;;
  esac
  return 1
}
if near_hour; then
  echo "Near the hour, waiting until :03 to restart"
  while near_hour; do sleep 20; done
fi

docker compose up -d
# Each build leaves the old image as <none>
docker image prune -f

# Watch for 20 seconds: up -d succeeds even if new code crashes and keeps restarting.
# Don't print container logs here: the repo is public, so anyone can read the Actions logs
before=$(docker inspect -f '{{.RestartCount}}' big-ben)
sleep 20
state=$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' big-ben)
if [ "$state" != "running $before" ]; then
  echo "Container is not stable (state, restarts: $state). Check docker compose logs big-ben on the VPS" >&2
  exit 1
fi
