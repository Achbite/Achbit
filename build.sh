#!/usr/bin/env bash
# Update the local runnable product by default; distribution packaging is explicit.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/source-identity.sh"
CONTAINER_NAME="${CONTAINER_NAME:-achbit-dev}"
WORKDIR_IN_CTNR="${WORKDIR_IN_CTNR:-/workspace}"
OUTPUT_DIR="${ACHBIT_OUTPUT_DIR:-$ROOT_DIR/bin}"
[[ "$OUTPUT_DIR" = /* ]] || OUTPUT_DIR="$ROOT_DIR/$OUTPUT_DIR"
export ACHBIT_BUILD_KIND=normal
export ACHBIT_BUILD_COMMIT="${ACHBIT_BUILD_COMMIT:-$(achbit_source_commit "$ROOT_DIR")}"
export ACHBIT_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAGES=()
usage() {
  cat <<'HELP'
Usage: bash build.sh [-debug] [--stage STAGE]...
  -debug              Windows/macOS Debug runtime/archive in bin/debug, without installers.
  runtime (default)    Compile and update the development host's runnable product in bin/.
  runtime-macos | runtime-windows | runtime-linux  Update one runtime without archives/installers.
  code                 Compile only shared TypeScript, GUI resources and Linux Rust code in Docker.
  package              Build and package every available platform; fail if none built.
  package-linux       Linux runtime for the container architecture.
  package-windows     Windows x64 runtime, ZIP and Setup (GNU cross toolchain + NSIS).
  package-macos       macOS arm64 runtime, archive and PKG; Docker delegates to its Mac host.
  ui                  Build shared TypeScript + GUI once, publish bin/ui.
  daemon | cli | tui  Build only the selected Linux native executable.
  native-gui          Build only the Linux native GUI shell.
  computer-use        Update only the independently signed macOS Computer Use App.
  computer-use-windows  Update only Achbit-Computer-Use.exe in bin/win64 (GUI may keep running).
Environment: CONTAINER_NAME, WORKDIR_IN_CTNR, ACHBIT_OUTPUT_DIR,
  CARGO_TARGET_DIR, RUSTC_WRAPPER, SCCACHE_DIR,
  ACHBIT_MACOS_CARGO, ACHBIT_MACOS_NODE_BIN, ACHBIT_MACOS_CARGO_TARGET_DIR,
  ACHBIT_MACOS_SIGN_IDENTITY (default: Achbit Local Development).
Tools must already be installed. Package stages use a fresh staging directory;
Cargo/pnpm caches are retained. User data in existing output directories is retained.
Runtime builds include current native programs and shared resources; macOS Apps are signed.
Docker runtime builds require the host platform supplied by make shell (ACHBIT_BUILD_HOST_OS).
The explicit code stage retains compiler outputs without updating bin/.
Full packaging: bash build.sh --stage package
On Mac, make shell prepares the host bridge before entering Docker.
HELP
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    -debug) export ACHBIT_BUILD_KIND=debug; shift ;;
    --stage) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; STAGES+=("$2"); shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
if [ "$ACHBIT_BUILD_KIND" = debug ]; then
  if [ -n "${ACHBIT_OUTPUT_DIR+x}" ] && [ "$OUTPUT_DIR" != "$ROOT_DIR/bin/debug" ]; then
    printf 'Debug output is fixed at bin/debug; remove conflicting ACHBIT_OUTPUT_DIR.\n' >&2; exit 2
  fi
  OUTPUT_DIR="$ROOT_DIR/bin/debug"
  [ "${#STAGES[@]}" -gt 0 ] || STAGES=(package)
  for stage in "${STAGES[@]}"; do
    case "$stage" in
      package|package-macos|package-windows) ;;
      *) printf 'Debug stage is not supported: %s (use package-windows or package-macos).\n' "$stage" >&2; exit 2 ;;
    esac
  done
else
  [ "${#STAGES[@]}" -gt 0 ] || STAGES=(runtime)
fi
IN_CONTAINER=0
[ ! -f /.dockerenv ] || IN_CONTAINER=1
if [ "$IN_CONTAINER" -eq 0 ]; then
  mounted_root="$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$WORKDIR_IN_CTNR\"}}{{.Source}}{{end}}{{end}}" "$CONTAINER_NAME")"
  [ "$mounted_root" = "$ROOT_DIR" ] || { printf 'Container %s mounts another worktree; use make shell with this worktree configuration.\n' "$CONTAINER_NAME" >&2; exit 1; }
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")" = true ] || { printf 'Container is not running; use make shell.\n' >&2; exit 1; }
fi
case "$OUTPUT_DIR/" in "$ROOT_DIR/"*) ;; *) printf 'Output must be inside the mounted worktree.\n' >&2; exit 2 ;; esac
mkdir -p "$ROOT_DIR/.build-cache"
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
  elif [ "$1" = check-runtime ]; then
    bash "$ROOT_DIR/scripts/package-macos.sh" --runtime --check
  elif [ "$1" = computer-use ]; then
    bash "$ROOT_DIR/scripts/package-macos.sh" --computer-use "$OUTPUT_DIR"
  elif [ "$1" = runtime ]; then
    bash "$ROOT_DIR/scripts/package-macos.sh" --runtime "$TRANSACTION/shared" "$OUTPUT_DIR"
  else
    bash "$ROOT_DIR/scripts/package-macos.sh" "$TRANSACTION/shared" "$OUTPUT_DIR"
  fi
}
container_step() {
  if [ "$IN_CONTAINER" -eq 1 ]; then
    bash "$ROOT_DIR/scripts/build-platforms.sh" "$@"
  else
    local name
    local environment=(-e ACHBIT_BUILD_COMMIT -e ACHBIT_BUILD_TIME -e ACHBIT_BUILD_KIND -e ACHBIT_BUILD_VERSION)
    for name in PNPM_STORE_DIR ACHBIT_WINDOWS_NODE_BIN ACHBIT_NODE_LICENSE ACHBIT_DISABLE_SCCACHE; do
      [ -z "${!name+x}" ] || environment+=(-e "$name")
    done
    docker exec -w "$WORKDIR_IN_CTNR" "${environment[@]}" -e ACHBIT_BUILD_PID_FILE="$(container_path "$TRANSACTION")/container.pid" "$CONTAINER_NAME" setsid --wait bash ./scripts/build-platforms.sh "$@"
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
package_platforms=()
native_stages=()
code=0
ui=0
computer_use=0
computer_use_windows=0
all=0
add_platform() {
  [ "${2:-package}" != package ] || package_platforms+=("$1")
  local existing
  for existing in "${platforms[@]:-}"; do [ "$existing" != "$1" ] || return 0; done
  platforms+=("$1")
}
package_selected() {
  local selected
  for selected in "${package_platforms[@]:-}"; do [ "$selected" != "$1" ] || return 0; done
  return 1
}
local_platform() {
  local build_host_os="${ACHBIT_BUILD_HOST_OS:-}"
  if [ -z "$build_host_os" ]; then
    if [ "$IN_CONTAINER" -eq 1 ]; then
      printf 'Container host platform is missing (ACHBIT_BUILD_HOST_OS). Re-enter with make shell from the host, or choose --stage runtime-macos/runtime-windows/runtime-linux explicitly.\n' >&2
      return 2
    fi
    build_host_os="$(uname -s)"
  fi
  case "$build_host_os" in
    Darwin) printf 'macos\n' ;;
    Windows_NT|MINGW*|MSYS*|CYGWIN*) printf 'windows\n' ;;
    Linux)
      if [ -n "${WSL_DISTRO_NAME:-}" ]; then printf 'windows\n'; else printf 'linux\n'; fi
      ;;
    *) printf 'Unsupported development host: %s\n' "$build_host_os" >&2; return 2 ;;
  esac
}
for stage in "${STAGES[@]}"; do
  case "$stage" in
    runtime)
      selected_platform="$(local_platform)"
      add_platform "$selected_platform" runtime
      ;;
    runtime-linux|runtime-windows|runtime-macos) add_platform "${stage#runtime-}" runtime ;;
    code) code=1 ;;
    package)
      all=1
      [ "$ACHBIT_BUILD_KIND" = debug ] || add_platform linux
      add_platform windows; add_platform macos
      ;;
    package-linux|package-windows|package-macos) add_platform "${stage#package-}" ;;
    ui) ui=1 ;;
    computer-use) computer_use=1 ;;
    computer-use-windows) computer_use_windows=1 ;;
    daemon|cli|tui|native-gui) native_stages+=("$stage") ;;
    *) printf 'Unknown stage: %s\n' "$stage" >&2; usage >&2; exit 2 ;;
  esac
done
available=()
for platform in "${platforms[@]:-}"; do
  [ -n "$platform" ] || continue
  check_action=check-runtime
  if package_selected "$platform"; then check_action=check; fi
  if [ "$platform" = macos ]; then
    check=(macos_step "$check_action")
  else
    check=(container_step "--$check_action" "$platform")
  fi
  current_stage="check-$platform"
  if reason="$("${check[@]}" 2>&1)"; then
    available+=("$platform")
    [ "$platform" != macos ] || printf '==[build][host]== macOS arm64 build host available\n'
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
elif [ "$code" -eq 1 ]; then
  current_stage=shared
  container_step --compile-shared
fi
if [ "$code" -eq 1 ]; then
  current_stage=code
  container_step --native code
  built_platforms+=(code)
fi
if [ "$ui" -eq 1 ]; then
  python3 "$ROOT_DIR/scripts/update-ui.py" --assets "$TRANSACTION/shared/web-achbit-gui" --output "$OUTPUT_DIR/ui/web-achbit-gui"
  rm -rf -- "$OUTPUT_DIR/ui/web"
fi
for stage in "${native_stages[@]:-}"; do
  current_stage="$stage"
  [ -z "$stage" ] || container_step --native "$stage"
done
built=0
runtime_built=0
if [ "$computer_use" -eq 1 ]; then
  current_stage=computer-use
  macos_step computer-use --shared "$TRANSACTION/shared" --output "$OUTPUT_DIR"
  built_platforms+=(computer-use)
fi
if [ "$computer_use_windows" -eq 1 ]; then
  current_stage=computer-use-windows
  container_step --computer-use-windows "$CONTAINER_OUTPUT"
  built_platforms+=(computer-use-windows)
fi
for platform in "${available[@]:-}"; do
  [ -n "$platform" ] || continue
  phase_start=$SECONDS
  current_stage="$platform"
  operation=runtime
  if package_selected "$platform"; then operation=package; fi
  printf '==[build][platform][START]== %s mode=%s\n' "$platform" "$operation"
  if [ "$platform" = macos ]; then
    macos_step "$operation" --shared "$TRANSACTION/shared" --output "$OUTPUT_DIR"
  else
    container_step "--$operation" "$platform" "$SHARED_DIR" "$CONTAINER_OUTPUT"
  fi
  runtime_built=$((runtime_built + 1))
  if [ "$operation" = package ]; then built=$((built + 1)); fi
  built_platforms+=("$platform")
  printf '==[build][platform][DONE]== %s seconds=%s\n' "$platform" "$((SECONDS - phase_start))"
done
printf '==[build][DONE]== runtimes=%s packages=%s updated="%s" skipped="%s" seconds=%s' "$runtime_built" "$built" "${built_platforms[*]:-none}" "${skipped_platforms[*]:-none}" "$((SECONDS - started))"
if [ "$runtime_built" -gt 0 ] || [ "$ui" -eq 1 ] || [ "$computer_use" -eq 1 ] || [ "$computer_use_windows" -eq 1 ]; then
  printf ' output=%s' "$OUTPUT_DIR"
fi
printf '\n'
