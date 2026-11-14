#!/usr/bin/env bash
# Host entrypoint: the agent supplies text; release.py owns the executable workflow.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec python3 -B "$ROOT_DIR/scripts/release.py" "$@"
