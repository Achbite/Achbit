#!/usr/bin/env bash
# Achbit 本地开发验证入口。测试直接调用真实构建与运行路径，不经过自定义控制器。
# 验证后端链路与显示/输入逻辑（例如权限和问题隔离），不以视觉观感或具体 CSS 写法为断言。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
source "$ROOT_DIR/scripts/source-identity.sh"

profile='required'
skipped_checks=0
if [ "${1:-}" = '--profile' ]; then
  [ "$#" -eq 2 ] || { printf '用法：%s --profile <static|required|cli|full>\n' "$0" >&2; exit 2; }
  profile="$2"
elif [ "$#" -eq 1 ]; then
  profile="$1"
elif [ "$#" -ne 0 ]; then
  printf '用法：%s [static|required|cli|full]\n' "$0" >&2
  exit 2
fi

case "$profile" in
  static|required|cli|full) ;;
  help|-h|--help)
    printf '用法：%s [static|required|cli|full]\n' "$0"
    exit 0
    ;;
  *) printf '未知验证范围：%s\n' "$profile" >&2; exit 2 ;;
esac

if [ "$profile" != 'static' ]; then
  if [ ! -f /.dockerenv ] && ! grep -qaE '(docker|containerd|kubepods)' /proc/1/cgroup 2>/dev/null; then
    printf 'required/cli/full 验证必须在开发容器内执行；请先运行 make shell。\n' >&2
    exit 3
  fi
  for tool in cargo node pnpm python3; do
    command -v "$tool" >/dev/null 2>&1 || { printf '缺少命令：%s\n' "$tool" >&2; exit 1; }
  done
fi
run_static() {
  printf '[test] 脚本语法与 diff 格式\n'
  local script
  for script in ./test.sh ./build.sh ./entrypoint.sh ./scripts/*.sh; do
    bash -n "$script"
  done
  if achbit_source_git_available "$ROOT_DIR"; then
    achbit_source_git "$ROOT_DIR" diff --check
  else
    printf '[test] Git diff check: SKIP (Git metadata is host-owned and unavailable in this compile/test snapshot)\n'
    skipped_checks=$((skipped_checks + 1))
  fi
}

run_required() {
  run_static
  printf '[test] Rust workspace\n'
  cargo fmt --all -- --check
  cargo test --workspace
  printf '[test] Debug 控制专用合同\n'
  cargo test -p achbit-kernel-daemon -p achbit-cli --features achbit-kernel-daemon/debug-control,achbit-cli/debug-control debug
  printf '[test] 构建编排与程序发布\n'
  python3 -I -S ./scripts/tests/build-platforms.py
  printf '[test] GUI 资源发布\n'
  python3 -I -S ./scripts/tests/ui-update.py
  printf '[test] Userspace 共享依赖\n'
  pnpm --store-dir "${PNPM_STORE_DIR:-${PNPM_HOME:-$HOME/.local/share/pnpm}/store}" install --frozen-lockfile
  pnpm build:userspace-shared
  printf '[test] TUI 字体选择与窗口启动参数\n'
  node --test ./shells/tui/tests/*.test.mjs
  printf '[test] Session 数据流\n'
  pnpm --filter @achbit/session-core test
  printf '[test] GUI 投影合同与状态交互\n'
  pnpm --filter @achbit/client test
  printf '[test] GUI 类型接线（共享包已编译）\n'
  pnpm --filter @achbit/client typecheck
  printf '[test] 手工预览类型接线\n'
  pnpm --filter @achbit/client typecheck:manual
}

run_workspace_shell() {
  printf '[test] Workspace Shell CLI\n'
  local workspace_status=0
  python3 -I -S ./scripts/tests/workspace-shell-cli.py || workspace_status=$?
  case "$workspace_status" in
    0) ;;
    77)
      skipped_checks=$((skipped_checks + 1))
      printf '[test] Workspace Shell CLI: SKIP (sandbox UNAVAILABLE; see the reason above; isolation was not verified)\n'
      ;;
    *)
      printf '[test] Workspace Shell CLI: FAIL (exit=%s)\n' "$workspace_status" >&2
      return "$workspace_status"
      ;;
  esac
}

# E2E scripts consume the outputs selected here; direct calls must supply these paths.
if [ "$profile" = cli ] || [ "$profile" = full ]; then
  test_target_dir="${CARGO_TARGET_DIR:-$ROOT_DIR/target}"
  export ACHBIT_E2E_DAEMON="${ACHBIT_E2E_DAEMON:-$test_target_dir/debug/achbit-kernel-daemon}"
  export ACHBIT_E2E_CLI="${ACHBIT_E2E_CLI:-$test_target_dir/debug/achbit-cli}"
  export ACHBIT_E2E_TUI="${ACHBIT_E2E_TUI:-$test_target_dir/debug/achbit-tui}"
  export ACHBIT_E2E_SESSION_BRIDGE="${ACHBIT_E2E_SESSION_BRIDGE:-$ROOT_DIR/userspace/session-core/dist/sessionServiceBridge.js}"
fi

case "$profile" in
  static) run_static ;;
  required) run_required ;;
  cli)
    run_required
    printf '[test] CLI 与 daemon 正式入口\n'
    cargo build -p achbit-first-party-tools -p achbit-kernel-daemon -p achbit-cli -p achbit-tui
    python3 -I -S ./scripts/tests/owned-daemon.py
    python3 -I -S ./scripts/tests/tool-input-cli-e2e.py
    python3 -I -S ./scripts/tests/provider-retry-cli.py
    python3 -I -S ./scripts/tests/permission-delegation-cli.py
    python3 -I -S ./scripts/tests/agent-composition-cli.py
    python3 -I -S ./scripts/tests/file-access-cli.py
    run_workspace_shell
    python3 -I -S ./scripts/tests/managed-process-cli.py
    python3 -I -S ./scripts/tests/subagent-cli.py
    python3 -I -S ./scripts/tests/conversation-storage.py
    ;;
  full)
    run_required
    printf '[test] CLI、TUI 与 GUI 正式包入口\n'
    cargo build -p achbit-first-party-tools -p achbit-kernel-daemon -p achbit-cli -p achbit-tui -p achbit-host-web
    pnpm --filter @achbit/client build:web
    python3 -I -S ./scripts/tests/owned-daemon.py
    printf '[test] 本地 Agent 真实链路与共享投影壳\n'
    python3 -I -S ./scripts/tests/tool-input-cli-e2e.py
    python3 -I -S ./scripts/tests/provider-retry-cli.py
    python3 -I -S ./scripts/tests/permission-delegation-cli.py
    python3 -I -S ./scripts/tests/agent-composition-cli.py
    python3 -I -S ./scripts/tests/file-access-cli.py
    run_workspace_shell
    python3 -I -S ./scripts/tests/managed-process-cli.py
    python3 -I -S ./scripts/tests/subagent-cli.py
    python3 -I -S ./scripts/tests/conversation-storage.py
    python3 -I -S ./scripts/tests/local-agent-e2e.py
    python3 -I -S ./scripts/tests/document-render-e2e.py
    ;;
esac

printf '[test] 登记链路检查完成 profile=%s，入口跳过=%s（SKIP 不计通过；测试不等于效果、稳定性、真实 Provider 或发布验收）\n' "$profile" "$skipped_checks"
