#!/usr/bin/env bash
# Clean Achbit development caches and dependency artifacts.
#
# Default scope is project-local and Achbit-specific:
#   - Achbit dev container/image/named volumes
#   - repo-local node_modules, pnpm store, Cargo target, build cache, dist outputs
#   - Linux/Windows package build outputs while preserving package-local user data
#   - macOS package build outputs while preserving package-local user data
#
# Host-global caches and global Docker pruning are opt-in because they can affect
# unrelated projects.
# Usage:
#   bash scripts/clean-caches.sh [options]
# Examples:
#   bash scripts/clean-caches.sh
#   bash scripts/clean-caches.sh --yes --include-host-global --include-docker-builder
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

dry_run=1
include_docker=1
include_local=1
include_macos_package=1
include_host_global=0
include_docker_builder=0
include_docker_system=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/clean-caches.sh [options]

Default behavior:
  Dry-run only. Shows the Achbit project caches that would be removed.

Execute:
  scripts/clean-caches.sh --yes

Options:
  --yes                         Execute cleanup. Without this flag, the script is dry-run.
  -n, --dry-run                 Show cleanup actions without deleting anything.
  --skip-docker                 Do not remove Achbit dev container/image/named volumes.
  --skip-local                  Do not remove repo-local dependency/build caches.
  --include-macos-package       Remove bin/macos-arm64 product build outputs (default; explicit alias).
  --skip-macos-package          Do not remove bin/macos-arm64 product build outputs.
  --include-host-global         Also remove host-global pnpm/npm/cargo/sccache caches.
  --include-docker-builder      Also run docker builder prune -f.
  --include-docker-system       Also run docker system prune -a --volumes -f.
  -h, --help                    Show this help.

Preserved by default:
  bin/linux-x64/config
  bin/linux-x64/sessions
  bin/linux-arm64/config
  bin/linux-arm64/sessions
  bin/win64/config
  bin/win64/sessions
  bin/macos-arm64/config
  bin/macos-arm64/sessions

Examples:
  scripts/clean-caches.sh
  scripts/clean-caches.sh --yes
  scripts/clean-caches.sh --yes --include-host-global --include-docker-builder
USAGE
}

log() {
  printf '==[clean-caches]== %s\n' "$*"
}

warn() {
  printf '==[clean-caches][warn]== %s\n' "$*" >&2
}

fail() {
  printf '==[clean-caches][error]== %s\n' "$*" >&2
  exit 1
}

quote_args() {
  local out=""
  local arg
  for arg in "$@"; do
    printf -v arg '%q' "$arg"
    out+=" $arg"
  done
  printf '%s' "${out# }"
}

run_command() {
  if [ "$dry_run" -eq 1 ]; then
    printf '+ %s\n' "$(quote_args "$@")"
    return 0
  fi
  "$@"
}


remove_path() {
  local path="$1"
  if [ ! -e "$path" ] && [ ! -L "$path" ]; then
    log "skip missing path: $path"
    return 0
  fi
  run_command rm -rf "$path"
}


clean_portable_package_outputs() {
  local package_dir="$1"
  local platform="$2"
  log "remove $platform program outputs; preserve user data"
  local entries entry
  entries="$(python3 -B - "$ROOT_DIR/scripts/package-runtime.py" <<'PYTHON'
import importlib.util
from pathlib import Path
import sys
sys.path.insert(0, str(Path(sys.argv[1]).parent))
spec = importlib.util.spec_from_file_location('package_runtime', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print('\n'.join(sorted(module.PROGRAM_ENTRIES)))
PYTHON
)"
  while IFS= read -r entry; do
    remove_path "$package_dir/$entry"
  done <<< "$entries"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

process_matches_path() {
  local target="$1"
  ps -axo pid=,command= | ACHBIT_PROCESS_TARGET="$target" \
    awk 'index($0, ENVIRON["ACHBIT_PROCESS_TARGET"]) > 0 { print }'
}

fail_if_macos_package_running() {
  local macos_dir="$ROOT_DIR/bin/macos-arm64"
  local targets=(
    "$macos_dir/Achbit.app/Contents/MacOS/Achbit"
    "$macos_dir/Achbit.app/Contents/MacOS/achbit-kernel"
  )
  local target
  local matches
  for target in "${targets[@]}"; do
    matches="$(process_matches_path "$target" || true)"
    if [ -n "$matches" ]; then
      printf '%s\n' "$matches" >&2
      fail "packaged Achbit process is still running; quit the app before cleaning macOS package outputs."
    fi
  done
}

clean_achbit_docker() {
  if [ "$include_docker" -ne 1 ]; then
    log "skip Achbit Docker resources"
    return 0
  fi
  if ! command_exists docker; then
    warn "docker is not available; skip Achbit Docker resources"
    return 0
  fi

  log "remove Docker resources selected by the current worktree Makefile"
  run_command make -C "$ROOT_DIR" clean
}

clean_repo_local() {
  if [ "$include_local" -ne 1 ]; then
    log "skip repo-local caches"
    return 0
  fi

  log "remove repo-local dependency/build caches"
  local paths=(
    "$ROOT_DIR/.build-cache"
    "$ROOT_DIR/.pnpm-store"
    "$ROOT_DIR/target"
    "$ROOT_DIR/node_modules"
    "$ROOT_DIR/userspace/gui/node_modules"
    "$ROOT_DIR/userspace/session-core/node_modules"
    "$ROOT_DIR/userspace/protocol/node_modules"
    "$ROOT_DIR/userspace/presentation-core/node_modules"
    "$ROOT_DIR/shells/achbit-gui/node_modules"
    "$ROOT_DIR/userspace/gui/dist"
    "$ROOT_DIR/userspace/gui/dist-achbit-gui"
    "$ROOT_DIR/userspace/session-core/dist"
    "$ROOT_DIR/userspace/protocol/dist"
    "$ROOT_DIR/userspace/presentation-core/dist"
    "$ROOT_DIR/shells/achbit-gui/dist"
    "$ROOT_DIR/userspace/gui/tsconfig.tsbuildinfo"
    "$ROOT_DIR/userspace/session-core/tsconfig.tsbuildinfo"
    "$ROOT_DIR/userspace/protocol/tsconfig.tsbuildinfo"
    "$ROOT_DIR/shells/achbit-gui/tsconfig.tsbuildinfo"
  )

  local path
  for path in "${paths[@]}"; do
    remove_path "$path"
  done

  clean_portable_package_outputs "$ROOT_DIR/bin/linux-x64" "linux-x64"
  clean_portable_package_outputs "$ROOT_DIR/bin/linux-arm64" "linux-arm64"
  clean_portable_package_outputs "$ROOT_DIR/bin/win64" "win64"
}

clean_macos_package_outputs() {
  if [ "$include_macos_package" -ne 1 ]; then
    log "skip macOS package outputs"
    return 0
  fi
  if [ "$dry_run" -ne 1 ]; then
    fail_if_macos_package_running
  fi

  clean_portable_package_outputs "$ROOT_DIR/bin/macos-arm64" "macos-arm64"
}

clean_host_global() {
  if [ "$include_host_global" -ne 1 ]; then
    log "skip host-global pnpm/npm/cargo/sccache caches"
    return 0
  fi

  log "remove host-global pnpm/npm/cargo/sccache caches"
  if command_exists pnpm; then
    local pnpm_store
    pnpm_store="$(pnpm store path 2>/dev/null || true)"
    if [ -n "$pnpm_store" ]; then
      remove_path "$pnpm_store"
    else
      warn "pnpm store path was empty; skip pnpm store"
    fi
  else
    warn "pnpm is not available; skip pnpm store"
  fi

  if command_exists npm; then
    run_command npm cache clean --force
  else
    warn "npm is not available; skip npm cache"
  fi

  remove_path "$HOME/.cargo/registry"
  remove_path "$HOME/.cargo/git"
  remove_path "${SCCACHE_DIR:-$HOME/Library/Caches/sccache}"
  remove_path "$HOME/.cache/sccache"
}

clean_global_docker_builder() {
  if [ "$include_docker_builder" -ne 1 ]; then
    log "skip Docker builder cache"
    return 0
  fi
  if ! command_exists docker; then
    warn "docker is not available; skip Docker builder cache"
    return 0
  fi
  log "prune Docker builder cache"
  run_command docker builder prune -f
}

clean_global_docker_system() {
  if [ "$include_docker_system" -ne 1 ]; then
    log "skip Docker system prune"
    return 0
  fi
  if ! command_exists docker; then
    warn "docker is not available; skip Docker system prune"
    return 0
  fi
  log "prune Docker system cache, images, stopped containers, networks, and volumes"
  run_command docker system prune -a --volumes -f
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes)
      dry_run=0
      shift
      ;;
    -n|--dry-run)
      dry_run=1
      shift
      ;;
    --skip-docker)
      include_docker=0
      shift
      ;;
    --skip-local)
      include_local=0
      shift
      ;;
    --include-macos-package)
      include_macos_package=1
      shift
      ;;
    --skip-macos-package)
      include_macos_package=0
      shift
      ;;
    --include-host-global)
      include_host_global=1
      shift
      ;;
    --include-docker-builder)
      include_docker_builder=1
      shift
      ;;
    --include-docker-system)
      include_docker_system=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

cd "$ROOT_DIR"

log "ROOT_DIR=$ROOT_DIR"
if [ "$dry_run" -eq 1 ]; then
  log "dry-run mode; add --yes to execute cleanup"
else
  log "execute mode"
fi

if [ "$include_host_global" -eq 1 ]; then
  warn "host-global cache cleanup can affect unrelated projects"
fi
if [ "$include_docker_builder" -eq 1 ] || [ "$include_docker_system" -eq 1 ]; then
  warn "global Docker pruning can affect unrelated projects"
fi

clean_achbit_docker
clean_repo_local
clean_macos_package_outputs
clean_host_global
clean_global_docker_builder
clean_global_docker_system

log "done"
