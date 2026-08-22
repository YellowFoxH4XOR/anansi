#!/bin/sh
set -eu

DATA_DIR=${ANANSI_DATA:-/data}
MARKER="$DATA_DIR/.anansi-node-owned-v1"

case "$DATA_DIR" in
  ""|/)
    echo "refusing to migrate unsafe ANANSI_DATA path: ${DATA_DIR:-<empty>}" >&2
    exit 1
    ;;
esac

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ ! -e "$MARKER" ]; then
    echo "ANANSI data: migrating $DATA_DIR ownership to node (uid 1000)"
    chown -R node:node "$DATA_DIR"
    touch "$MARKER"
    chown node:node "$MARKER"
  fi
  exec /usr/bin/setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
