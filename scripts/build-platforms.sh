#!/usr/bin/env bash
# Internal build steps. build.sh owns selection and the shared-assets lifetime.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
[ -f /.dockerenv ] || { printf 'Shared/Linux/Windows builds require the project Docker container.\n' >&2; exit 1; }
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/target}"
GUI_MANIFEST="$ROOT_DIR/shells/deepcode-gui/src-tauri/Cargo.toml"
WINDOWS_TARGET=x86_64-pc-windows-gnu
# Container installation defaults; callers may override these locations.
PNPM_STORE_DIR="${PNPM_STORE_DIR:-${PNPM_HOME:-$HOME/.local/share/pnpm}/store}"
DEEPCODE_WINDOWS_NODE_BIN="${DEEPCODE_WINDOWS_NODE_BIN:-/opt/deepcode-node-win64/node.exe}"
stage=""
cleanup() {
  [ -z "$stage" ] || rm -rf -- "$stage"
  [ -z "${DEEPCODE_BUILD_PID_FILE:-}" ] || rm -f -- "$DEEPCODE_BUILD_PID_FILE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "${DEEPCODE_BUILD_PID_FILE:-}" ]; then
  printf '%s\n' "$$" > "$DEEPCODE_BUILD_PID_FILE"
fi
require() { command -v "$1" >/dev/null || { printf 'Missing build tool: %s\n' "$1" >&2; exit 1; }; }
check_platform() {
  require cargo; require node; require pnpm; require python3
  case "$1" in
    linux)
      require strip; require bwrap
      pkg-config --exists openssl gtk+-3.0 webkit2gtk-4.1 ayatana-appindicator3-0.1 librsvg-2.0 || { printf 'Linux desktop SDK is incomplete.\n' >&2; exit 1; }
      ;;
    windows)
      require x86_64-w64-mingw32-gcc; require x86_64-w64-mingw32-g++; require x86_64-w64-mingw32-strip; require makensis
      [ -d "$(rustc --print target-libdir --target "$WINDOWS_TARGET")" ] || { printf 'Rust Windows GNU target is not installed.\n' >&2; exit 1; }
      [ -f "${DEEPCODE_WINDOWS_NODE_BIN}" ]
      ;;
    *) printf 'Unsupported container platform: %s\n' "$1" >&2; exit 2 ;;
  esac
}
configure_cache() {
  if [ -z "${RUSTC_WRAPPER:-}" ] && [ "${DEEPCODE_DISABLE_SCCACHE:-0}" != 1 ] && command -v sccache >/dev/null; then
    export RUSTC_WRAPPER="$(command -v sccache)"
    export SCCACHE_DIR="${SCCACHE_DIR:-$CARGO_TARGET_DIR/.sccache}"
  fi
}
case "${1:-}" in
  --check) check_platform "$2" ;;
  --shared)
    destination="$2"
    started=$SECONDS
    printf '==[build][shared][START]== dependencies, TypeScript, GUI\n'
    pnpm --store-dir "${PNPM_STORE_DIR}" install --frozen-lockfile
    pnpm build:userspace-shared
    pnpm --filter @deepcode/client typecheck
    pnpm --filter @deepcode/client build:web
    mkdir -p "$destination"
    dependencies="$(dirname "$destination")/dependencies.json"
    pnpm --filter @deepcode/client --filter @deepcode/session-core list --prod --depth Infinity --json > "$dependencies"
    python3 scripts/package-runtime.py shared "$ROOT_DIR" "$destination" "$dependencies"
    printf '==[build][shared][DONE]== seconds=%s\n' "$((SECONDS - started))"
    ;;
  --computer-use-windows)
    # Replace only the Windows desktop executor in an existing win64 runtime.
    output="$2"
    check_platform windows
    configure_cache
    cargo build --release --target "$WINDOWS_TARGET" -p deepcode-computer-use
    python3 scripts/computer_use_package.py --windows --native "$CARGO_TARGET_DIR/$WINDOWS_TARGET/release" --output "$output/win64"
    ;;
  --native)
    configure_cache
    case "$2" in
      native-gui) cargo build --release --manifest-path "$GUI_MANIFEST" ;;
      daemon) cargo build --release -p deepcode-kernel-daemon -p deepcode-first-party-tools ;;
      cli) cargo build --release -p deepcode-cli ;;
      tui) cargo build --release -p deepcode-tui ;;
      *) printf 'Unknown native stage: %s\n' "$2" >&2; exit 2 ;;
    esac
    ;;
  --package)
    platform="$2"; shared="$3"; output="$4"
    check_platform "$platform"
    configure_cache
    target_args=()
    node="$(command -v node)"
    node_license="${DEEPCODE_NODE_LICENSE:-$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve().parent.parent / "LICENSE")' "$node")}"
    native="$CARGO_TARGET_DIR/release"
    loader_args=()
    if [ "$platform" = windows ]; then
      target_args=(--target "$WINDOWS_TARGET")
      native="$CARGO_TARGET_DIR/$WINDOWS_TARGET/release"
      platform_dir=win64
      node="$DEEPCODE_WINDOWS_NODE_BIN"
    else
      case "$(uname -m)" in x86_64) platform_dir=linux-x64 ;; aarch64) platform_dir=linux-arm64 ;; *) printf 'Unsupported Linux architecture.\n' >&2; exit 1 ;; esac
    fi
    cargo build --release "${target_args[@]}" -p deepcode-kernel-daemon -p deepcode-first-party-tools -p deepcode-host-web -p deepcode-cli -p deepcode-tui
    if [ "$platform" = windows ]; then
      # The desktop executor is a sibling program of the Windows GUI.
      cargo build --release "${target_args[@]}" -p deepcode-computer-use
      messages="$(dirname "$shared")/windows-native.jsonl"
      cargo build --release "${target_args[@]}" --manifest-path "$GUI_MANIFEST" --message-format=json-render-diagnostics > "$messages"
      # Read this Cargo invocation's dependency output, not a glob over cached builds.
      loader="$(python3 -c 'import json,sys; from pathlib import Path; messages=map(json.loads,open(sys.argv[1])); output=next(m["out_dir"] for m in messages if m.get("reason")=="build-script-executed" and m["package_id"].split("#")[-1].startswith("webview2-com-sys@")); print(Path(output)/"x64/WebView2Loader.dll")' "$messages")"
      loader_args=(--webview-loader "$loader")
    else
      cargo build --release --manifest-path "$GUI_MANIFEST"
    fi
    stage="$(mktemp -d "$(dirname "$shared")/$platform_dir.XXXXXX")"
    python3 scripts/package-runtime.py assemble --root "$ROOT_DIR" --platform "$platform_dir" --stage "$stage" --shared "$shared" --native "$native" --node "$node" --node-license "$node_license" "${loader_args[@]}"
    version="$(node -p 'require("./package.json").version')"
    archive="$output/DeepCode-$version-$platform_dir.tar.gz"
    [ "$platform" != windows ] || archive="$output/DeepCode-$version-$platform_dir.zip"
    installer_args=()
    if [ "$platform" = windows ]; then
      installer="$(dirname "$shared")/DeepCode-$version-win64-setup.exe"
      python3 scripts/package-installers.py win64 "$stage" "$installer"
      installer_args=(--installer "$installer")
    fi
    python3 scripts/package-runtime.py publish "$stage" "$output/$platform_dir" "$archive" "${installer_args[@]}"
    ;;
  *) printf 'Internal usage: --check platform | --shared directory | --native stage | --package platform shared output | --computer-use-windows output\n' >&2; exit 2 ;;
esac
