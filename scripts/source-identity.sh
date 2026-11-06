#!/usr/bin/env bash
# Shared, path-independent source identity for build and package tooling.
# This file only defines functions and is safe to source from another script.

achbit_source_git() {
  local root="$1"
  shift
  # The caller selected this worktree. Bind mounts may retain a different host
  # owner; trust only this directory for this invocation, never global config.
  git -c safe.directory="$root" -C "$root" "$@"
}

achbit_source_git_available() {
  command -v git >/dev/null 2>&1 || return 1
  achbit_source_git "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

achbit_source_commit() {
  achbit_source_git "$1" rev-parse HEAD
}
