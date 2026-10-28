#!/usr/bin/env bash
# Internal build steps. build.sh owns selection and the shared-assets lifetime.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
[ -f /.dockerenv ] || { printf 'Shared/Linux/Windows builds require the project Docker container.\n' >&2; exit 1; }
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/target}"
GUI_MANIFEST="$ROOT_DIR/shells/achbit-gui/src-tauri/Cargo.toml"
WINDOWS_TARGET=x86_64-pc-windows-gnu
# Container installation defaults; callers may override these locations.
PNPM_STORE_DIR="${PNPM_STORE_DIR:-${PNPM_HOME:-$HOME/.local/share/pnpm}/store}"
ACHBIT_WINDOWS_NODE_BIN="${ACHBIT_WINDOWS_NODE_BIN:-/opt/achbit-node-win64/node.exe}"
stage=""
cleanup() {
  [ -z "$stage" ] || rm -rf -- "$stage"
  [ -z "${ACHBIT_BUILD_PID_FILE:-}" ] || rm -f -- "$ACHBIT_BUILD_PID_FILE"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -n "${ACHBIT_BUILD_PID_FILE:-}" ]; then
  printf '%s\n' "$$" > "$ACHBIT_BUILD_PID_FILE"
fi
require() { command -v "$1" >/dev/null || { printf 'Missing build tool: %s\n' "$1" >&2; exit 1; }; }
check_platform() {
  require cargo; require node; require pnpm; require python3
  case "$1" in
    linux)
      require strip; require bwrap
      if [ "${2:-package}" = package ]; then require appimagetool; fi
      pkg-config --exists openssl gtk+-3.0 webkit2gtk-4.1 ayatana-appindicator3-0.1 librsvg-2.0 || { printf 'Linux desktop SDK is incomplete.\n' >&2; exit 1; }
      ;;
    windows)
      require x86_64-w64-mingw32-gcc; require x86_64-w64-mingw32-g++; require x86_64-w64-mingw32-strip
      if [ "${2:-package}" = package ] && [ "${ACHBIT_BUILD_KIND:-normal}" != debug ]; then require makensis; fi
      [ -d "$(rustc --print target-libdir --target "$WINDOWS_TARGET")" ] || { printf 'Rust Windows GNU target is not installed.\n' >&2; exit 1; }
      [ -f "${ACHBIT_WINDOWS_NODE_BIN}" ]
      ;;
    *) printf 'Unsupported container platform: %s\n' "$1" >&2; exit 2 ;;
  esac
}
configure_cache() {
  if [ -z "${RUSTC_WRAPPER:-}" ] && [ "${ACHBIT_DISABLE_SCCACHE:-0}" != 1 ] && command -v sccache >/dev/null; then
    export RUSTC_WRAPPER="$(command -v sccache)"
    export SCCACHE_DIR="${SCCACHE_DIR:-$CARGO_TARGET_DIR/.sccache}"
  fi
}
case "${1:-}" in
  --check) check_platform "$2" ;;
  --check-runtime) check_platform "$2" runtime ;;
  --compile-shared|--shared)
    started=$SECONDS
    printf '==[build][shared][START]== dependencies, TypeScript, GUI\n'
    pnpm --store-dir "${PNPM_STORE_DIR}" install --frozen-lockfile
    pnpm build:userspace-shared
    pnpm --filter @achbit/client typecheck
    pnpm --filter @achbit/client build:web
    if [ "$1" = --shared ]; then
      destination="$2"
      mkdir -p "$destination"
      dependencies="$(dirname "$destination")/dependencies.json"
      pnpm --filter @achbit/client --filter @achbit/session-core --filter @achbit/chrome-devtools-runtime list --prod --depth Infinity --json > "$dependencies"
      python3 scripts/package-runtime.py shared "$ROOT_DIR" "$destination" "$dependencies"
    fi
    printf '==[build][shared][DONE]== seconds=%s\n' "$((SECONDS - started))"
    ;;
  --computer-use-windows)
    # Replace only the Windows desktop executor in an existing win64 runtime.
    output="$2"
    check_platform windows
    configure_cache
    cargo build --release --target "$WINDOWS_TARGET" -p achbit-computer-use
    python3 scripts/computer_use_package.py --windows --native "$CARGO_TARGET_DIR/$WINDOWS_TARGET/release" --output "$output/win64"
    ;;
  --native)
    configure_cache
    case "$2" in
      code)
        started=$SECONDS
        printf '==[build][code][START]== Linux Rust workspace and GUI shell\n'
        cargo build --release --workspace
        cargo build --release --manifest-path "$GUI_MANIFEST"
        printf '==[build][code][DONE]== seconds=%s native=%s/release\n' "$((SECONDS - started))" "$CARGO_TARGET_DIR"
        ;;
      native-gui) cargo build --release --manifest-path "$GUI_MANIFEST" ;;
      daemon) cargo build --release -p achbit-kernel-daemon -p achbit-first-party-tools ;;
      cli) cargo build --release -p achbit-cli ;;
      tui) cargo build --release -p achbit-tui ;;
      *) printf 'Unknown native stage: %s\n' "$2" >&2; exit 2 ;;
    esac
    ;;
  --runtime|--package)
    platform="$2"; shared="$3"; output="$4"
    check_platform "$platform" "${1#--}"
    configure_cache
    target_args=()
    node="$(command -v node)"
    node_license="${ACHBIT_NODE_LICENSE:-$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve().parent.parent / "LICENSE")' "$node")}"
    native="$CARGO_TARGET_DIR/release"
    loader_args=()
    if [ "$platform" = windows ]; then
      target_args=(--target "$WINDOWS_TARGET")
      native="$CARGO_TARGET_DIR/$WINDOWS_TARGET/release"
      platform_dir=win64
      node="$ACHBIT_WINDOWS_NODE_BIN"
    else
      case "$(uname -m)" in x86_64) platform_dir=linux-x64 ;; aarch64) platform_dir=linux-arm64 ;; *) printf 'Unsupported Linux architecture.\n' >&2; exit 1 ;; esac
    fi
    export TAURI_CONFIG="$(python3 scripts/package-updates.py config)"
    cargo_features=()
    gui_features=()
    product=Achbit
    if [ "${ACHBIT_BUILD_KIND:-normal}" = debug ]; then
      [ "$platform" = windows ] || { printf 'Unsupported Debug container platform: %s\n' "$platform" >&2; exit 2; }
      cargo_features=(--features achbit-kernel-daemon/debug-control,achbit-cli/debug-control)
      gui_features=(--features debug-control)
      product=Achbit-Debug
    fi
    cargo build --release "${target_args[@]}" "${cargo_features[@]}" -p achbit-kernel-daemon -p achbit-first-party-tools -p achbit-host-web -p achbit-cli -p achbit-tui
    if [ "$platform" = windows ]; then
      # The desktop executor is a sibling program of the Windows GUI.
      cargo build --release "${target_args[@]}" -p achbit-computer-use
      messages="$(dirname "$shared")/windows-native.jsonl"
      cargo build --release "${target_args[@]}" "${gui_features[@]}" --manifest-path "$GUI_MANIFEST" --message-format=json-render-diagnostics > "$messages"
      # Read this Cargo invocation's dependency output, not a glob over cached builds.
      loader="$(python3 -c 'import json,sys; from pathlib import Path; messages=map(json.loads,open(sys.argv[1])); output=next(m["out_dir"] for m in messages if m.get("reason")=="build-script-executed" and m["package_id"].split("#")[-1].startswith("webview2-com-sys@")); print(Path(output)/"x64/WebView2Loader.dll")' "$messages")"
      loader_args=(--webview-loader "$loader")
    else
      cargo build --release --manifest-path "$GUI_MANIFEST"
    fi
    stage="$(mktemp -d "$(dirname "$shared")/$platform_dir.XXXXXX")"
    python3 scripts/package-runtime.py assemble --root "$ROOT_DIR" --platform "$platform_dir" --stage "$stage" --shared "$shared" --native "$native" --node "$node" --node-license "$node_license" "${loader_args[@]}"
    if [ "$1" = --runtime ]; then
      python3 scripts/package-runtime.py publish "$stage" "$output/$platform_dir"
      exit 0
    fi
    version="$(python3 scripts/package-updates.py version)"
    archive="$output/$product-$version-$platform_dir.tar.gz"
    [ "$platform" != windows ] || archive="$output/$product-$version-$platform_dir.zip"
    if [ "$platform" = linux ]; then
      python3 scripts/package-updates.py linux "$stage" "$output/$product-$version-$platform_dir.AppImage"
    fi
    installer_args=()
    if [ "$platform" = windows ] && [ "${ACHBIT_BUILD_KIND:-normal}" != debug ]; then
      installer="$(dirname "$shared")/Achbit-$version-win64-setup.exe"
      python3 scripts/package-installers.py win64 "$stage" "$installer"
      installer_args=(--installer "$installer")
    fi
    python3 scripts/package-runtime.py publish "$stage" "$output/$platform_dir" "$archive" "${installer_args[@]}"
    ;;
  *) printf 'Internal usage: --check/--check-runtime platform | --compile-shared | --shared directory | --native stage | --runtime/--package platform shared output | --computer-use-windows output\n' >&2; exit 2 ;;
esac
