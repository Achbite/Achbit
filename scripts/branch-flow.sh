#!/usr/bin/env bash
# Small single-maintainer helpers for Achbit task branches.
set -euo pipefail

git() {
  /usr/bin/git "$@"
}

readonly MANAGED_MARKER='managed-by: achbit-branch-flow'

die() {
  printf '==[branch-flow][error]== %s\n' "$*" >&2
  exit 1
}

info() {
  printf '==[branch-flow]== %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage:
  scripts/branch-flow.sh audit
  scripts/branch-flow.sh install-hooks
  scripts/branch-flow.sh start <kernel|session|ui|fix|hotfix|release> <slug> [--worktree PATH]
  scripts/branch-flow.sh publish --target <dev-main|main>
  scripts/branch-flow.sh sync
EOF
}

require_repo() {
  [ -x /usr/bin/git ] || die '/usr/bin/git is required'
  git rev-parse --show-toplevel >/dev/null 2>&1 \
    || die 'run this command inside a Achbit Git worktree'
}

repo_root() {
  git rev-parse --show-toplevel
}

common_git_dir() {
  git rev-parse --path-format=absolute --git-common-dir
}

current_branch() {
  git symbolic-ref --quiet --short HEAD \
    || die 'detached HEAD is not valid for this command'
}

is_protected_branch() {
  case "$1" in
    main|dev-main) return 0 ;;
    *) return 1 ;;
  esac
}

route_allowed() {
  local head="$1"
  local target="$2"
  case "$target:$head" in
    dev-main:kernel/*|dev-main:session/*|dev-main:ui/*|dev-main:fix/*|dev-main:main) return 0 ;;
    main:dev-main|main:hotfix/*|main:release/*) return 0 ;;
    *) return 1 ;;
  esac
}

assert_clean_worktree() {
  local worktree="$1"
  [ -z "$(git -C "$worktree" status --porcelain)" ] \
    || die "worktree has uncommitted changes: $worktree"
}

worktree_for_branch() {
  local wanted="$1"
  local worktree=''
  local branch=''
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      worktree\ *) worktree="${line#worktree }"; branch='' ;;
      branch\ refs/heads/*) branch="${line#branch refs/heads/}" ;;
      '')
        if [ "$branch" = "$wanted" ]; then
          printf '%s\n' "$worktree"
          return 0
        fi
        worktree=''
        branch=''
        ;;
    esac
  done < <(git worktree list --porcelain; printf '\n')
  return 1
}

install_hooks() {
  require_repo
  local root
  local hooks_dir
  local hook
  local source
  local destination
  root="$(repo_root)"
  hooks_dir="$(common_git_dir)/hooks"
  mkdir -p "$hooks_dir"

  for hook in reference-transaction pre-push; do
    source="$root/.githooks/$hook"
    destination="$hooks_dir/$hook"
    [ -f "$source" ] || die "missing versioned hook: $source"
    if [ -e "$destination" ] && ! grep -Fq "$MANAGED_MARKER" "$destination"; then
      die "refusing to overwrite an unmanaged hook: $destination"
    fi
    cp "$source" "$destination"
    chmod 0755 "$destination"
    info "installed shared hook: $destination"
  done
}

audit() {
  require_repo
  git status --short --branch
  git worktree list
  git branch -vv
}

start_branch() {
  require_repo
  local kind="${1:-}"
  local slug="${2:-}"
  [ -n "$kind" ] && [ -n "$slug" ] \
    || die 'start requires a branch kind and slug'
  shift 2

  case "$kind" in
    kernel|session|ui|fix|hotfix|release) ;;
    *) die "unsupported branch kind: $kind" ;;
  esac
  [[ "$slug" =~ ^[a-z0-9][a-z0-9._-]*$ ]] \
    || die 'slug must use lowercase letters, digits, dots, underscores, or hyphens'

  local worktree
  local base='dev-main'
  local branch="$kind/$slug"
  worktree="$(repo_root)"
  [ "$kind" = 'hotfix' ] && base='main'

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --worktree)
        [ "$#" -ge 2 ] || die '--worktree requires a path'
        worktree="$2"
        shift 2
        ;;
      *) die "unknown start option: $1" ;;
    esac
  done

  git -C "$worktree" rev-parse --show-toplevel >/dev/null 2>&1 \
    || die "not a Git worktree: $worktree"
  [ "$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)" = "$(common_git_dir)" ] \
    || die "worktree belongs to another repository: $worktree"
  assert_clean_worktree "$worktree"

  git -C "$worktree" fetch origin --prune
  git -C "$worktree" show-ref --verify --quiet "refs/heads/$base" \
    || die "missing local base: $base"
  git -C "$worktree" show-ref --verify --quiet "refs/remotes/origin/$base" \
    || die "missing remote base: origin/$base"
  [ "$(git -C "$worktree" rev-parse "$base")" = "$(git -C "$worktree" rev-parse "origin/$base")" ] \
    || die "$base must match origin/$base before starting work"
  if git -C "$worktree" show-ref --verify --quiet "refs/heads/$branch" \
    || git -C "$worktree" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    die "branch already exists: $branch"
  fi

  git -C "$worktree" switch -c "$branch" "$base"
  info "created local task branch: $branch from $base"
}

publish_branch() {
  require_repo
  local target=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --target)
        [ "$#" -ge 2 ] || die '--target requires a branch'
        target="$2"
        shift 2
        ;;
      *) die "unknown publish option: $1" ;;
    esac
  done
  case "$target" in
    main|dev-main) ;;
    *) die 'publish requires --target main or dev-main' ;;
  esac

  local head
  local root
  head="$(current_branch)"
  root="$(repo_root)"
  is_protected_branch "$head" \
    && die "protected branches are updated only through Pull Requests: $head"
  route_allowed "$head" "$target" \
    || die "PR route is not allowed: $head -> $target"
  assert_clean_worktree "$root"

  git fetch origin --prune
  git show-ref --verify --quiet "refs/remotes/origin/$target" \
    || die "missing target: origin/$target"
  git merge-base --is-ancestor "origin/$target" HEAD \
    || die "update the task branch from origin/$target before publishing"
  git diff --check "origin/$target...HEAD"
  [ "$(git rev-list --count "origin/$target..HEAD")" -gt 0 ] \
    || die "no commits are available for PR: $head -> $target"

  git push -u origin "HEAD:refs/heads/$head"
  info "published task branch: $head -> $target"
}

sync_protected() {
  require_repo
  local branch
  local worktree
  git fetch origin --prune

  for branch in main dev-main; do
    git show-ref --verify --quiet "refs/heads/$branch" \
      || die "missing local branch: $branch"
    git show-ref --verify --quiet "refs/remotes/origin/$branch" \
      || die "missing remote branch: origin/$branch"
    git merge-base --is-ancestor "$branch" "origin/$branch" \
      || die "local $branch contains commits not present in origin/$branch"

    worktree="$(worktree_for_branch "$branch" || true)"
    if [ -n "$worktree" ] && [ -d "$worktree" ]; then
      assert_clean_worktree "$worktree"
      git -C "$worktree" merge --ff-only "origin/$branch"
    else
      git branch -f "$branch" "origin/$branch"
    fi
    info "synchronized local $branch"
  done
}

main() {
  local command="${1:-}"
  [ -n "$command" ] || { usage; exit 1; }
  shift
  case "$command" in
    audit) [ "$#" -eq 0 ] || die 'audit takes no arguments'; audit ;;
    install-hooks) [ "$#" -eq 0 ] || die 'install-hooks takes no arguments'; install_hooks ;;
    start) start_branch "$@" ;;
    publish) publish_branch "$@" ;;
    sync) [ "$#" -eq 0 ] || die 'sync takes no arguments'; sync_protected ;;
    help|-h|--help) usage ;;
    *) usage; die "unknown command: $command" ;;
  esac
}

main "$@"
