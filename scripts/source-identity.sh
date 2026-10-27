#!/usr/bin/env bash
# Shared, path-independent source identity for build and package tooling.
# This file only defines functions and is safe to source from another script.

achbit_source_git_available() {
  local root="$1"
  command -v git >/dev/null 2>&1 || return 1
  git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

achbit_source_commit() {
  local root="$1"
  if ! achbit_source_git_available "$root"; then
    printf 'unknown\n'
    return 0
  fi
  git -C "$root" rev-parse HEAD
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
  git -C "$root" status --porcelain=v1 --untracked-files=all
}

achbit_source_dirty() {
  local root="$1"
  if [ -n "$(achbit_source_status "$root")" ]; then
    printf '1\n'
  else
    printf '0\n'
  fi
}
