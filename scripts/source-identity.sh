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

achbit_source_status() {
  local root="$1"
  if ! achbit_source_git_available "$root"; then
    # Docker compile snapshots can contain a linked-worktree .git file whose
    # host-only absolute gitdir is intentionally unavailable in the container.
    # Keep that state explicit and dirty instead of emitting a Git fatal or
    # accidentally certifying the snapshot as clean.
    printf 'git-metadata=unavailable\n'
    return 0
  fi
  achbit_source_git "$root" status --porcelain=v1 --untracked-files=all
}

achbit_source_dirty() {
  local root="$1"
  if [ -n "$(achbit_source_status "$root")" ]; then
    printf '1\n'
  else
    printf '0\n'
  fi
}
