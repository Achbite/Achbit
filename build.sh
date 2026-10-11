#!/usr/bin/env bash
# One invocation prepares shared assets once, then builds the selected native targets.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/source-identity.sh"
CONTAINER_NAME="${CONTAINER_NAME:-deepcode-dev}"
WORKDIR_IN_CTNR="${WORKDIR_IN_CTNR:-/workspace}"
OUTPUT_DIR="${DEEPCODE_OUTPUT_DIR:-$ROOT_DIR/bin}"
[[ "$OUTPUT_DIR" = /* ]] || OUTPUT_DIR="$ROOT_DIR/$OUTPUT_DIR"
export DEEPCODE_BUILD_COMMIT="${DEEPCODE_BUILD_COMMIT:-$(deepcode_source_commit "$ROOT_DIR")}"
export DEEPCODE_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAGES=()
usage() {
  cat <<'HELP'
Usage: bash build.sh [--stage STAGE]...
  package (default)    Build every available platform; fail if none built.
  package-linux       Linux runtime for the container architecture.
  package-windows     Windows x64 runtime, ZIP and Setup (GNU cross toolchain + NSIS).
  package-macos       macOS arm64 runtime, archive and PKG; Docker delegates to its Mac host.
  ui                  Build shared TypeScript + GUI once, publish bin/ui.
  daemon | cli | tui  Build only the selected Linux native executable.
  native-gui          Build only the Linux native GUI shell.
  computer-use        Update only the independently signed macOS Computer Use App.
Environment: CONTAINER_NAME, WORKDIR_IN_CTNR, DEEPCODE_OUTPUT_DIR,
  CARGO_TARGET_DIR, RUSTC_WRAPPER, SCCACHE_DIR,
  DEEPCODE_MACOS_CARGO, DEEPCODE_MACOS_NODE_BIN, DEEPCODE_MACOS_CARGO_TARGET_DIR,
  DEEPCODE_MACOS_SIGN_IDENTITY (default: DeepCode Local Development).
Tools must already be installed. Package stages use a fresh staging directory;
Cargo/pnpm caches are retained. User data in existing output directories is retained.
On Mac, make shell prepares the host bridge before entering Docker.
HELP
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --stage) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; STAGES+=("$2"); shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ "${#STAGES[@]}" -gt 0 ] || STAGES=(package)
IN_CONTAINER=0
[ ! -f /.dockerenv ] || IN_CONTAINER=1
if [ "$IN_CONTAINER" -eq 0 ]; then
  mounted_root="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$WORKDIR_IN_CTNR\"}}{{.Source}}{{end}}{{end}}" "$CONTAINER_NAME")"
  [ "$mounted_root" = "$ROOT_DIR" ] || { printf 'Container %s mounts another worktree; use make shell with this worktree configuration.\n' "$CONTAINER_NAME" >&2; exit 1; }
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" = true ] || { printf 'Container is not running; use make shell.\n' >&2; exit 1; }
fi
case "$OUTPUT_DIR/" in "$ROOT_DIR/"*) ;; *) printf 'Output must be inside the mounted worktree.\n' >&2; exit 2 ;; esac
mkdir -p "$OUTPUT_DIR" "$ROOT_DIR/.build-cache"
BUILD_LOCK="$ROOT_DIR/.build-cache/build.lock"
mkdir "$BUILD_LOCK" 2>/dev/null || { printf 'Another build owns %s; wait for it to finish.\n' "$BUILD_LOCK" >&2; exit 1; }
TRANSACTION="$(mktemp -d "$ROOT_DIR/.build-cache/package.XXXXXX")"
printf '%s\n' "$TRANSACTION" > "$BUILD_LOCK/transaction"
started=$SECONDS
current_stage=preflight
built_platforms=()
skipped_platforms=()
cleanup() {
  local status="$1"
  local macos_pending=0
  trap - EXIT INT TERM
  if [ "$IN_CONTAINER" -eq 0 ] && [ -f "$TRANSACTION/container.pid" ]; then
    local process_group
    process_group="$(cat "$TRANSACTION/container.pid")"
    docker exec "$CONTAINER_NAME" kill -TERM -- "-$process_group" || printf 'Could not stop this build process group: %s\n' "$process_group" >&2
  fi
  if [ -f "$TRANSACTION/macos-request" ]; then
    if ! python3 "$ROOT_DIR/scripts/macos-build-bridge.py" cancel --shared "$TRANSACTION/shared"; then
      status=1
      macos_pending=1
    fi
  fi
  if [ "$macos_pending" -eq 1 ]; then
    printf 'Mac host has not confirmed exit; retaining staging and build lock: %s\n' "$TRANSACTION" >&2
  else
    rm -rf -- "$TRANSACTION" "$BUILD_LOCK"
  fi
  if [ "$status" -ne 0 ]; then
    printf '==[build][FAILED]== stage=%s exit=%s updated="%s" skipped="%s"\n' "$current_stage" "$status" "${built_platforms[*]:-none}" "${skipped_platforms[*]:-none}" >&2
  fi
  exit "$status"
}
trap 'cleanup $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
container_path() { printf '%s/%s' "$WORKDIR_IN_CTNR" "${1#"$ROOT_DIR/"}"; }
macos_step() {
  if [ "$IN_CONTAINER" -eq 1 ]; then
    python3 "$ROOT_DIR/scripts/macos-build-bridge.py" "$@"
  elif [ "$(uname -s)" != Darwin ]; then
    printf 'No macOS build host is registered for this worktree.\n'; return 3
  elif [ "$1" = check ]; then
    bash "$ROOT_DIR/scripts/package-macos.sh" --check
  elif [ "$1" = computer-use ]; then
    bash "$ROOT_DIR/scripts/package-macos.sh" --computer-use "$OUTPUT_DIR"
  else
    bash "$ROOT_DIR/scripts/package-macos.sh" "$TRANSACTION/shared" "$OUTPUT_DIR"
  fi
}
container_step() {
  if [ "$IN_CONTAINER" -eq 1 ]; then
    bash "$ROOT_DIR/scripts/build-platforms.sh" "$@"
  else
    local name
    local environment=(-e DEEPCODE_BUILD_COMMIT -e DEEPCODE_BUILD_TIME)
    for name in PNPM_STORE_DIR DEEPCODE_WINDOWS_NODE_BIN DEEPCODE_NODE_LICENSE DEEPCODE_DISABLE_SCCACHE; do
      [ -z "${!name+x}" ] || environment+=(-e "$name")
    done
    docker exec -w "$WORKDIR_IN_CTNR" "${environment[@]}" -e DEEPCODE_BUILD_PID_FILE="$(container_path "$TRANSACTION")/container.pid" "$CONTAINER_NAME" setsid --wait bash ./scripts/build-platforms.sh "$@"
  fi
}
if [ "$IN_CONTAINER" -eq 1 ]; then
  SHARED_DIR="$TRANSACTION/shared"
  CONTAINER_OUTPUT="$OUTPUT_DIR"
else
  SHARED_DIR="$(container_path "$TRANSACTION")/shared"
  CONTAINER_OUTPUT="$(container_path "$OUTPUT_DIR")"
fi
platforms=()
native_stages=()
ui=0
computer_use=0
all=0
add_platform() { local existing; for existing in "${platforms[@]:-}"; do [ "$existing" != "$1" ] || return 0; done; platforms+=("$1"); }
for stage in "${STAGES[@]}"; do
  case "$stage" in
    package) all=1; add_platform linux; add_platform windows; add_platform macos ;;
    package-linux|package-windows|package-macos) add_platform "${stage#package-}" ;;
    ui) ui=1 ;;
    computer-use) computer_use=1 ;;
    daemon|cli|tui|native-gui) native_stages+=("$stage") ;;
    *) printf 'Unknown stage: %s\n' "$stage" >&2; usage >&2; exit 2 ;;
  esac
done
available=()
for platform in "${platforms[@]:-}"; do
  [ -n "$platform" ] || continue
  if [ "$platform" = macos ]; then
    check=(macos_step check)
  else
    check=(container_step --check "$platform")
  fi
  current_stage="check-$platform"
  if reason="$("${check[@]}" 2>&1)"; then
    available+=("$platform")
    [ "$platform" != macos ] || printf '==[build][host]== macOS arm64 packaging available\n'
  else
    check_status=$?
    if [ "$all" -eq 1 ] && { [ "$platform" != macos ] || [ "$check_status" -eq 3 ]; }; then
      skipped_platforms+=("$platform")
      printf '==[build][SKIPPED]== %s: %s\n' "$platform" "$reason"
    else
      printf '==[build][error]== %s: %s\n' "$platform" "$reason" >&2; exit "$check_status"
    fi
  fi
done
[ "${#platforms[@]}" -eq 0 ] || [ "${#available[@]}" -gt 0 ] || { printf 'No platform can be built.\n' >&2; exit 1; }
if [ "$ui" -eq 1 ] || [ "${#available[@]}" -gt 0 ]; then
  current_stage=shared
  container_step --shared "$SHARED_DIR"
fi
if [ "$ui" -eq 1 ]; then
  python3 "$ROOT_DIR/scripts/update-ui.py" --assets "$TRANSACTION/shared/web-deepcode-gui" --output "$OUTPUT_DIR/ui/web-deepcode-gui"
  rm -rf -- "$OUTPUT_DIR/ui/web"
fi
for stage in "${native_stages[@]:-}"; do
  current_stage="$stage"
  [ -z "$stage" ] || container_step --native "$stage"
done
built=0
if [ "$computer_use" -eq 1 ]; then
  current_stage=computer-use
  macos_step computer-use --shared "$TRANSACTION/shared" --output "$OUTPUT_DIR"
  built_platforms+=(computer-use)
fi
for platform in "${available[@]:-}"; do
  [ -n "$platform" ] || continue
  phase_start=$SECONDS
  current_stage="$platform"
  printf '==[build][platform][START]== %s\n' "$platform"
  if [ "$platform" = macos ]; then
    macos_step package --shared "$TRANSACTION/shared" --output "$OUTPUT_DIR"
  else
    container_step --package "$platform" "$SHARED_DIR" "$CONTAINER_OUTPUT"
  fi
  built=$((built + 1))
  built_platforms+=("$platform")
  printf '==[build][platform][DONE]== %s seconds=%s\n' "$platform" "$((SECONDS - phase_start))"
done
printf '==[build][DONE]== packages=%s updated="%s" skipped="%s" seconds=%s output=%s\n' "$built" "${built_platforms[*]:-none}" "${skipped_platforms[*]:-none}" "$((SECONDS - started))" "$OUTPUT_DIR"
