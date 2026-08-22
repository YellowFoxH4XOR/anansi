#!/usr/bin/env bash
set -euo pipefail

IMAGE="anansi-agent-volume-test:$$"
VOLUME="anansi-agent-volume-test-$$"

cleanup() {
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$(dirname "$0")/.."
docker build --build-arg WITH_BRIGHTDATA_CLI=false -f Dockerfile.agent -t "$IMAGE" . >/dev/null
docker volume create "$VOLUME" >/dev/null

# Reproduce a volume created by the former root-running agent image.
docker run --rm --user 0 -v "$VOLUME":/data node:22-slim sh -ec '
  mkdir -p /data/snapshots /data/fixtures
  printf "{}\n" > /data/runs.jsonl
  printf "{}" > /data/state.json
  chown -R root:root /data
  chmod 0755 /data
  chmod 0644 /data/runs.jsonl /data/state.json
'

# The new image must migrate ownership, then run the actual command as node.
docker run --rm -v "$VOLUME":/data "$IMAGE" sh -ec '
  test "$(id -u)" = "1000"
  test "$(stat -c %u /data)" = "1000"
  test "$(stat -c %u /data/runs.jsonl)" = "1000"
  printf "new run\n" >> /data/runs.jsonl
  rm /data/state.json
  printf "{}" > /data/state.json
  test -f /data/.anansi-node-owned-v1
'

echo "agent volume ownership migration: PASS"
