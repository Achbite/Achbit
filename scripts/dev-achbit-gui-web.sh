#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/dev-language.sh"
[ -f /.dockerenv ] || { dev_printf "Use make dev-achbit-gui from the host.\n" "请从宿主执行 make dev-achbit-gui。\n" >&2; exit 1; }
HOST="${ACHBIT_HOST:-127.0.0.1}"
GUI_PORT="${ACHBIT_GUI_DEV_PORT:-5174}"
HOST_PORT="${ACHBIT_HOST_PORT:-31245}"
DAEMON_PORT="${ACHBIT_DAEMON_PORT:-31246}"
CONFIG_SOURCE="${ACHBIT_DEV_CONFIG_SOURCE:-}"
RUNTIME_ROOT="${ACHBIT_DEV_CONFIG_ROOT:-}"
RUNTIME_ROOT_OWNED=0
DAEMON_PID=""
HOST_PID=""
VITE_PID=""

fail() {
  local message="$1"
  if [ "$ACHBIT_DEV_LANGUAGE" = zh-CN ]; then message="$2"; fi
  printf '[achbit-gui-web][error] %s\n' "$message" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1" "缺少命令：$1"
}

valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

port_is_free() {
  ! nc -z "$HOST" "$1" >/dev/null 2>&1
}

stop_owned_process() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" >/dev/null 2>&1 || return 0
  kill -TERM "$pid" >/dev/null 2>&1 || true
  local attempt=0
  while kill -0 "$pid" >/dev/null 2>&1 && [ "$attempt" -lt 20 ]; do
    sleep 0.1
    attempt=$((attempt + 1))
  done
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -KILL "$pid" >/dev/null 2>&1 || true
  fi
  wait "$pid" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_owned_process "$VITE_PID"
  stop_owned_process "$HOST_PID"
  stop_owned_process "$DAEMON_PID"
  if [ -n "${ACHBIT_DEV_CONTROL:-}" ] && [ -d "$ACHBIT_DEV_CONTROL" ]; then
    rm -f -- "$ACHBIT_DEV_CONTROL/pid"
  fi
  if [ "$RUNTIME_ROOT_OWNED" = "1" ] && [ -n "$RUNTIME_ROOT" ]; then
    case "$RUNTIME_ROOT" in
      "${TMPDIR:-/tmp}"/achbit-gui-web.*) rm -rf -- "$RUNTIME_ROOT" ;;
      *) dev_printf '[achbit-gui-web][warning] Left unexpected temporary directory in place: %s\n' '[achbit-gui-web][warning] 未清理非预期临时目录：%s\n' "$RUNTIME_ROOT" >&2 ;;
    esac
  fi
  exit "$status"
}

wait_for_health() {
  local pid="$1"
  local url="$2"
  local header_name="$3"
  local header_value="$4"
  local log_path="$5"
  local attempt=0
  while [ "$attempt" -lt 120 ]; do
    kill -0 "$pid" >/dev/null 2>&1 || {
      tail -n 40 "$log_path" >&2 || true
      return 1
    }
    if curl --silent --show-error --fail \
      --header "$header_name: $header_value" \
      "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
    attempt=$((attempt + 1))
  done
  tail -n 40 "$log_path" >&2 || true
  return 1
}

trap cleanup EXIT INT TERM

if [ -n "${ACHBIT_DEV_CONTROL:-}" ]; then
  [ -d "$ACHBIT_DEV_CONTROL" ] || fail "Development service owner is no longer active" "开发服务的所有者已退出"
  printf '%s\n' "$$" > "$ACHBIT_DEV_CONTROL/pid"
  [ ! -f "$ACHBIT_DEV_CONTROL/cancel" ] || exit 0
fi

[ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ] || [ "$HOST" = "::1" ] \
  || fail "The development Host must listen on loopback" "Web 开发 Host 只能监听 loopback"
valid_port "$GUI_PORT" || fail "ACHBIT_GUI_DEV_PORT must be an integer from 1 to 65535" "ACHBIT_GUI_DEV_PORT 必须是 1-65535 的整数"
valid_port "$HOST_PORT" || fail "ACHBIT_HOST_PORT must be an integer from 1 to 65535" "ACHBIT_HOST_PORT 必须是 1-65535 的整数"
valid_port "$DAEMON_PORT" || fail "ACHBIT_DAEMON_PORT must be an integer from 1 to 65535" "ACHBIT_DAEMON_PORT 必须是 1-65535 的整数"
[ "$GUI_PORT" != "$HOST_PORT" ] && [ "$GUI_PORT" != "$DAEMON_PORT" ] \
  && [ "$HOST_PORT" != "$DAEMON_PORT" ] || fail "GUI, Host and daemon ports must be distinct" "GUI、Host 和 daemon 端口必须互不相同"

require_command node
require_command curl

if [ "${ACHBIT_DEV_SKIP_BUILD:-0}" != "1" ]; then
  require_command pnpm
  require_command cargo
fi

for port in "$GUI_PORT" "$HOST_PORT" "$DAEMON_PORT"; do
  port_is_free "$port" || fail "Port is in use: $HOST:$port" "端口已被占用：$HOST:$port"
done

if [ -z "$RUNTIME_ROOT" ]; then
  RUNTIME_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/achbit-gui-web.XXXXXX")"
  RUNTIME_ROOT_OWNED=1
else
  mkdir -p "$RUNTIME_ROOT"
  RUNTIME_ROOT="$(cd "$RUNTIME_ROOT" && pwd)"
fi
chmod 700 "$RUNTIME_ROOT"
mkdir -p "$RUNTIME_ROOT/logs"

if [ -n "$CONFIG_SOURCE" ]; then
  [ -d "$CONFIG_SOURCE/config/user/local" ] \
    || fail "ACHBIT_DEV_CONFIG_SOURCE has no config/user/local: $CONFIG_SOURCE" "ACHBIT_DEV_CONFIG_SOURCE 不包含 config/user/local：$CONFIG_SOURCE"
  mkdir -p "$RUNTIME_ROOT/config/user/local"
  cp -R "$CONFIG_SOURCE/config/user/local/." "$RUNTIME_ROOT/config/user/local/"
fi

cd "$ROOT_DIR"
if [ "${ACHBIT_DEV_SKIP_BUILD:-0}" != "1" ]; then
  pnpm --filter @achbit/protocol build
  pnpm --filter @achbit/session-core build
  cargo build -p achbit-first-party-tools -p achbit-kernel-daemon -p achbit-host-web
fi

NATIVE="${CARGO_TARGET_DIR:-$ROOT_DIR/target}/debug"
DAEMON_BIN="$NATIVE/achbit-kernel-daemon"
HOST_BIN="$NATIVE/achbit-host-web"
SESSION_BRIDGE="$ROOT_DIR/userspace/session-core/dist/sessionServiceBridge.js"
VITE_BIN="$ROOT_DIR/userspace/gui/node_modules/vite/bin/vite.js"
NODE_BIN="$(command -v node)"
[ -x "$DAEMON_BIN" ] || fail "Daemon not found: $DAEMON_BIN" "缺少 daemon：$DAEMON_BIN"
[ -x "$HOST_BIN" ] || fail "Host not found: $HOST_BIN" "缺少 Host：$HOST_BIN"
[ -f "$SESSION_BRIDGE" ] || fail "Session bridge not found: $SESSION_BRIDGE" "缺少 Session bridge：$SESSION_BRIDGE"
[ -f "$VITE_BIN" ] || fail "Vite not found: $VITE_BIN" "缺少 Vite：$VITE_BIN"

random_hex() {
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
}

SHELL_TOKEN="achost_$(random_hex)"
UI_TOKEN="acui_$(random_hex)"
INSTANCE_ID="acinstance_$(random_hex)"

env -u ACHBIT_HOST_UI_TOKEN \
  ACHBIT_HOST="$HOST" \
  ACHBIT_PORT="$DAEMON_PORT" \
  ACHBIT_USER_ROOT="$RUNTIME_ROOT" \
  ACHBIT_SESSION_BRIDGE="$SESSION_BRIDGE" \
  ACHBIT_NODE="$NODE_BIN" \
  ACHBIT_HOST_SHELL_TOKEN="$SHELL_TOKEN" \
  ACHBIT_HOST_INSTANCE_ID="$INSTANCE_ID" \
  "$DAEMON_BIN" >"$RUNTIME_ROOT/logs/daemon.log" 2>&1 &
DAEMON_PID=$!
wait_for_health \
  "$DAEMON_PID" \
  "http://$HOST:$DAEMON_PORT/api/health" \
  "x-achbit-host-shell-token" \
  "$SHELL_TOKEN" \
  "$RUNTIME_ROOT/logs/daemon.log" \
  || fail "Kernel daemon failed to start" "Kernel daemon 启动失败"

env \
  ACHBIT_HOST="$HOST" \
  ACHBIT_PORT="$HOST_PORT" \
  ACHBIT_DAEMON_HOST="$HOST" \
  ACHBIT_DAEMON_PORT="$DAEMON_PORT" \
  ACHBIT_HOST_WEB_SPAWN_DAEMON=0 \
  ACHBIT_HOST_UI_TOKEN="$UI_TOKEN" \
  ACHBIT_HOST_SHELL_TOKEN="$SHELL_TOKEN" \
  ACHBIT_HOST_INSTANCE_ID="$INSTANCE_ID" \
  "$HOST_BIN" >"$RUNTIME_ROOT/logs/host-web.log" 2>&1 &
HOST_PID=$!
wait_for_health \
  "$HOST_PID" \
  "http://$HOST:$HOST_PORT/api/health" \
  "x-achbit-host-ui-token" \
  "$UI_TOKEN" \
  "$RUNTIME_ROOT/logs/host-web.log" \
  || fail "Host Web failed to start" "Host Web 启动失败"

(
  cd "$ROOT_DIR/userspace/gui"
  exec env \
    ACHBIT_HOST="$HOST" \
    ACHBIT_HOST_PORT="$HOST_PORT" \
    ACHBIT_GUI_DEV_PORT="$GUI_PORT" \
    ACHBIT_HOST_UI_TOKEN="$UI_TOKEN" \
    "$NODE_BIN" "$VITE_BIN" --config vite.achbit-gui.config.ts
) >"$RUNTIME_ROOT/logs/vite.log" 2>&1 &
VITE_PID=$!

attempt=0
while [ "$attempt" -lt 120 ]; do
  kill -0 "$VITE_PID" >/dev/null 2>&1 || {
    tail -n 40 "$RUNTIME_ROOT/logs/vite.log" >&2 || true
    fail "Vite failed to start" "Vite 启动失败"
  }
  if curl --silent --show-error --fail "http://$HOST:$GUI_PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
  attempt=$((attempt + 1))
done
[ "$attempt" -lt 120 ] || {
  tail -n 40 "$RUNTIME_ROOT/logs/vite.log" >&2 || true
  fail "Vite startup timed out" "Vite 启动超时"
}

dev_printf '[achbit-gui-web] Same-origin GUI is ready: http://%s:%s/\n' '[achbit-gui-web] 同源 GUI 已启动：http://%s:%s/\n' "$HOST" "$GUI_PORT"
dev_printf '[achbit-gui-web] runtime: %s\n' '[achbit-gui-web] runtime：%s\n' "$RUNTIME_ROOT"
dev_printf '[achbit-gui-web] PIDs: daemon=%s host=%s vite=%s\n' '[achbit-gui-web] PIDs：daemon=%s host=%s vite=%s\n' "$DAEMON_PID" "$HOST_PID" "$VITE_PID"
dev_printf '[achbit-gui-web] Ctrl+C stops these processes and removes their temporary runtime.\n' '[achbit-gui-web] Ctrl+C 将只停止上述进程并清理本次临时 runtime。\n'

while kill -0 "$DAEMON_PID" >/dev/null 2>&1 \
  && kill -0 "$HOST_PID" >/dev/null 2>&1 \
  && kill -0 "$VITE_PID" >/dev/null 2>&1; do
  sleep 1
done
fail "A development process exited early. See $RUNTIME_ROOT/logs" "开发拓扑中的进程提前退出；日志位于 $RUNTIME_ROOT/logs"
