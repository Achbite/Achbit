#!/usr/bin/env bash
# Darwin compilation only; build.sh supplies this invocation's Docker-built resources.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT_DIR"
[ "$(uname -s)/$(uname -m)" = Darwin/arm64 ] || { printf 'macOS native packaging requires a Darwin/arm64 executor. Use build.sh to select the host bridge.\n' >&2; exit 1; }
CARGO="${DEEPCODE_MACOS_CARGO:-$(command -v cargo || printf '%s/bin/cargo' "${CARGO_HOME:-$HOME/.cargo}")}"
NODE="${DEEPCODE_MACOS_NODE_BIN:-$(command -v node)}"
runtime_only=0
if [ "${1:-}" = --runtime ]; then runtime_only=1; shift; fi
command -v "$CARGO" >/dev/null || { printf 'Set DEEPCODE_MACOS_CARGO to the installed cargo executable.\n' >&2; exit 1; }
# A TUI-only native component for isolated verification or subsequent assembly.
# Full App assembly below remains the owner of package signing and publication.
if [ "${1:-}" = --tui ]; then
  [ "$#" -eq 2 ] || exit 2
  export CARGO_TARGET_DIR="${DEEPCODE_MACOS_CARGO_TARGET_DIR:-$ROOT_DIR/target/macos-arm64}"
  "$CARGO" build --release -p deepcode-tui
  mkdir -p "$2"
  cp "$CARGO_TARGET_DIR/release/deepcode-tui" "$2/deepcode-tui"
  exit 0
fi
if [ "${1:-}" = --computer-use ]; then
  [ "$#" -eq 2 ] || exit 2
  export CARGO_TARGET_DIR="${DEEPCODE_MACOS_CARGO_TARGET_DIR:-$ROOT_DIR/target/macos-arm64}"
  python3 scripts/macos_signing.py
  "$CARGO" build --release -p deepcode-computer-use
  python3 scripts/computer_use_package.py --native "$CARGO_TARGET_DIR/release" --output "$2/macos-arm64"
  exit 0
fi
for tool in xcrun codesign strip python3; do command -v "$tool" >/dev/null; done
if [ "$runtime_only" -eq 0 ] && [ "${DEEPCODE_BUILD_KIND:-normal}" != debug ]; then command -v pkgbuild >/dev/null; fi
xcrun --find clang >/dev/null
xcrun --sdk macosx --show-sdk-path >/dev/null
[ -x "$NODE" ] || { printf 'Set DEEPCODE_MACOS_NODE_BIN to the installed Node runtime.\n' >&2; exit 1; }
NODE_LICENSE="${DEEPCODE_MACOS_NODE_LICENSE:-$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve().parent.parent / "LICENSE")' "$NODE")}"
[ -f "$NODE_LICENSE" ] || { printf 'Node license missing: %s\n' "$NODE_LICENSE" >&2; exit 1; }
python3 scripts/macos_signing.py
[ "${1:-}" != --check ] || exit 0
[ "$#" -eq 2 ] || { printf 'Use build.sh --stage package-macos; shared assets are supplied by that invocation.\n' >&2; exit 2; }
SHARED="$1"
OUTPUT="$2"
cargo_args=(build --release)
gui_args=(build --release)
if [ "${DEEPCODE_BUILD_KIND:-normal}" = debug ]; then
  cargo_args+=(--features deepcode-kernel-daemon/debug-control,deepcode-cli/debug-control)
  gui_args+=(--features debug-control)
  export TAURI_CONFIG='{"productName":"DeepCode-Debug","identifier":"com.achbite.deepcode.debug"}'
fi
export CARGO_TARGET_DIR="${DEEPCODE_MACOS_CARGO_TARGET_DIR:-$ROOT_DIR/target/macos-arm64}"
"$CARGO" "${cargo_args[@]}" -p deepcode-kernel-daemon -p deepcode-first-party-tools -p deepcode-host-web -p deepcode-cli -p deepcode-tui -p deepcode-computer-use
"$CARGO" "${gui_args[@]}" --manifest-path "$ROOT_DIR/shells/deepcode-gui/src-tauri/Cargo.toml"
STAGE="$(mktemp -d "$(dirname "$SHARED")/macos-arm64.XXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT
python3 scripts/package-runtime.py assemble --root "$ROOT_DIR" --platform macos-arm64 --stage "$STAGE" --shared "$SHARED" --native "$CARGO_TARGET_DIR/release" --node "$NODE" --node-license "$NODE_LICENSE"
if [ "$runtime_only" -eq 1 ]; then
  python3 scripts/package-runtime.py publish "$STAGE" "$OUTPUT/macos-arm64"
  exit 0
fi
VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
if [ "${DEEPCODE_BUILD_KIND:-normal}" = debug ]; then
  python3 scripts/package-runtime.py publish "$STAGE" "$OUTPUT/macos-arm64" "$OUTPUT/DeepCode-Debug-$VERSION-macos-arm64.tar.gz"
else
  INSTALLER="$(dirname "$SHARED")/DeepCode-$VERSION-macos-arm64.pkg"
  python3 scripts/package-installers.py macos-arm64 "$STAGE" "$INSTALLER"
  python3 scripts/package-runtime.py publish "$STAGE" "$OUTPUT/macos-arm64" "$OUTPUT/DeepCode-$VERSION-macos-arm64.tar.gz" --installer "$INSTALLER"
fi
