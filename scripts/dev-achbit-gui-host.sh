#!/usr/bin/env bash
# Keep the container process group owned by this foreground development service.
set -euo pipefail
CONTAINER="$1"
WORKDIR="$2"
GUI_PORT="$3"
shift 3
CONTROL="$(docker exec "$CONTAINER" mktemp -d /tmp/achbit-gui-dev.XXXXXX)"
CLIENT_PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  docker exec -e ACHBIT_DEV_CONTROL="$CONTROL" "$CONTAINER" bash -c '
    [ -d "$ACHBIT_DEV_CONTROL" ] || exit 0
    touch "$ACHBIT_DEV_CONTROL/cancel"
    if [ -f "$ACHBIT_DEV_CONTROL/pid" ]; then
      read -r pid < "$ACHBIT_DEV_CONTROL/pid"
      kill -TERM -- "-$pid" 2>/dev/null || true
    fi
    rm -rf -- "$ACHBIT_DEV_CONTROL"
  ' || { printf "[achbit-gui-web] Could not stop owned container service: %s\n" "$CONTROL" >&2; status=1; }
  if [ -n "$CLIENT_PID" ]; then wait "$CLIENT_PID" 2>/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker exec "$@" -w "$WORKDIR" -e ACHBIT_GUI_BIND_HOST=0.0.0.0 \
  -e ACHBIT_GUI_DEV_PORT="$GUI_PORT" -e ACHBIT_HOST_PORT=31247 -e ACHBIT_DAEMON_PORT=31248 \
  -e ACHBIT_DEV_CONTROL="$CONTROL" "$CONTAINER" setsid --wait bash scripts/dev-achbit-gui-web.sh &
CLIENT_PID=$!
wait "$CLIENT_PID"
