#!/usr/bin/env bash
set -euo pipefail
# A pinned appimagetool release; extraction mode works without FUSE in Docker.
case "$(uname -m)" in aarch64) arch=aarch64 ;; x86_64) arch=x86_64 ;; *) exit 2 ;; esac
mkdir -p /opt/achbit-appimage
curl -fL --connect-timeout 15 --max-time 180 --retry 2 "https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-${arch}.AppImage" -o /opt/achbit-appimage/appimagetool.AppImage
chmod +x /opt/achbit-appimage/appimagetool.AppImage
cat > /usr/local/bin/appimagetool <<'TOOL'
#!/bin/sh
exec /opt/achbit-appimage/appimagetool.AppImage --appimage-extract-and-run "$@"
TOOL
chmod +x /usr/local/bin/appimagetool
